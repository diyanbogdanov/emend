/**
 * The seam between "something drifted" and everything that acts on it.
 *
 * Emend detects drift from more than one source now — a package's published
 * declarations, a version copied into a Dockerfile, a wire API pinned in a
 * constructor — and each of those was growing its own path to the surface. Pin
 * conflicts in particular lived beside the findings rather than among them, so
 * they were never stored, never tracked across scans, never rendered into a pull
 * request and never shown on the dashboard. Everything downstream consumes
 * `Finding`; anything that is not one is invisible to all of it.
 *
 * A detector's whole contract is: given a repository, produce findings. What it
 * reads, and whether it needs the network, is its own business.
 */

import { createHash } from 'node:crypto';
import ts from 'typescript';
import { inventoriesFor, type EcosystemInventory } from './ecosystems.ts';
import { diffSpecs } from './specdiff.ts';
import { packageOfSpecifier } from './callsites.ts';
import { remediationTarget, type InstalledPackage, type VulnerablePackage } from './osv.ts';
import { ordinal, rankVulnerable, type AdvisoryFacts } from './advisory.ts';
import type { LintAdapter } from './lint.ts';
import { extractPins, findPinConflicts, resolvedVersions, PIN_FILES } from './pins.ts';
import {
  checkAgainstSpec,
  matchAgainstDiff,
  exportedUrlConstants,
  findHttpCalls,
  mergeExportedConstants,
  type HttpCall,
} from './httpsites.ts';
import { canAssertBreakage, describeProvenance, type SpecCandidate } from './specs.ts';
import type { CallSite, Detector, Finding, InstalledDependency } from './types.ts';

/**
 * What every detector is given.
 *
 * `read` rather than a directory, so a detector is a pure function of what it
 * is handed and can be tested without a filesystem. `sourceFiles` is supplied
 * rather than walked, because the call-site pass already walks the repository
 * and doing it again per detector is the kind of cost that accumulates quietly.
 */
export interface DetectorContext {
  repoDir: string;
  dependencies: InstalledDependency[];
  /** Repo-relative source files, already discovered by the caller. */
  sourceFiles: string[];
  read: (file: string) => Promise<string | null>;
}

export interface DetectorFailure {
  detector: string;
  reason: string;
}

export interface DetectorRun {
  findings: Finding[];
  /** What each detector looked at without reaching a conclusion. Never dropped. */
  notes: string[];
  /**
   * Detectors that threw, and why.
   *
   * Returned rather than swallowed. A detector reaching the network or the
   * filesystem will fail sometimes, and a scan that loses every other result
   * because one adapter threw is worse than one that reports what it has — but
   * a scan that hides the failure is worse than both, because a missing finding
   * is indistinguishable from a clean result.
   */
  failures: DetectorFailure[];
}

/** Stable across scans, so the store tracks a finding rather than duplicating it. */
function pinFindingId(subject: string, from: string, to: string, file: string): string {
  return createHash('sha256')
    .update(`version-pin|${subject}|${from}|${to}|${file}`)
    .digest('hex')
    .slice(0, 12);
}

async function readPinFiles(ctx: DetectorContext): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const file of [...PIN_FILES, ...ctx.sourceFiles]) {
    if (files.has(file)) continue;
    const source = await ctx.read(file);
    if (source !== null) files.set(file, source);
  }
  return files;
}

/**
 * Versions the repository copied out of its lockfile into places nothing keeps
 * honest.
 *
 * Only conflicts with an authority become findings. A finding asserts a target
 * version, and three files declaring three versions with nothing to arbitrate
 * has no target — reporting the disagreement is honest, inventing a winner is
 * the guess `plan.ts` refuses to make.
 */
export const versionPinDetector: Detector = {
  id: 'version-pin',

  async applies(ctx: DetectorContext): Promise<boolean> {
    for (const file of PIN_FILES) {
      if ((await ctx.read(file)) !== null) return true;
    }
    return false;
  },

  async detect(ctx: DetectorContext): Promise<{ findings: Finding[] }> {
    const pins = extractPins(await readPinFiles(ctx));
    const conflicts = findPinConflicts(pins, resolvedVersions(ctx.dependencies));

    const findings = conflicts
      .filter((c) => c.expected !== null)
      .flatMap((conflict) =>
        conflict.pins.map((pin): Finding => {
          const to = conflict.expected as string;
          return {
            id: pinFindingId(conflict.subject, pin.version, to, pin.file),
            detector: 'version-pin',
            pkg: conflict.subject,
            fromVersion: pin.version,
            toVersion: to,
            change: {
              path: conflict.subject,
              kind: 'version-drift',
              severity: 'drift',
              confidence: 'high',
              before: pin.version,
              after: to,
              guidance: `${conflict.authority} says ${to}`,
            },
            // The pin itself is the call site. A finding without one is not a
            // finding, and here the evidence is exact: file, line, and the text
            // a repair has to match.
            sites: [{ file: pin.file, line: pin.line, column: 1, text: pin.text, via: 'import' }],
            confidence: 'high',
          };
        }),
      );
    return { findings };
  },
};

function httpFindingId(host: string, method: string, route: string): string {
  return createHash('sha256')
    .update(`http-contract|${host}|${method}|${route}`)
    .digest('hex')
    .slice(0, 12);
}

/** A second fingerprint, so a change between versions cannot erase a removal. */
function driftFindingId(host: string, path: string, kind: string): string {
  return createHash('sha256').update(`http-drift|${host}|${path}|${kind}`).digest('hex').slice(0, 12);
}

/** Everything this detector needs beyond the ordinary context. */
export interface HttpContractOptions {
  resolve: (vendor: { domain: string }) => Promise<SpecCandidate[]>;
  /**
   * The same description as it stood earlier, when one can be had.
   *
   * Injected like `resolve`, and for the same reason: obtaining it means more
   * outbound requests, and that is the operator's call. Without it this detector
   * answers only "is this route still described", which cannot see a deprecation
   * or a new capability — both of those are described, and only a comparison
   * between two versions carries them.
   */
  previous?: (candidate: SpecCandidate) => Promise<SpecCandidate | null>;
  /** Where a scan is willing to spend its network budget. */
  maxHosts?: number;
}

/**
 * Calls reaching endpoints their vendor's own description no longer contains.
 *
 * The detector the whole `http-contract` step exists for. A raw `fetch` has no
 * types, so nothing in a TypeScript build has any opinion about whether
 * `POST /v1/charges` is still a real endpoint — the request compiles, ships, and
 * fails in production. The description is the only surface it can be checked
 * against.
 *
 * Off by default, and injected rather than importing the resolver: this is the
 * only detector that reaches the network, and a `scan` that quietly starts
 * making outbound requests to every host in someone's source tree is not a thing
 * to switch on for them.
 *
 * `severity` is `breaking` and `confidence` is `medium`. The endpoint really is
 * gone from the provider's own description — that part is high — but whether
 * this particular call is the one that breaks depends on things no description
 * records, and `checkAgainstSpec` has already refused to speak at all where the
 * description was not authoritative or could not be aligned.
 */
export function httpContractDetector(options: HttpContractOptions): Detector {
  const maxHosts = options.maxHosts ?? 8;

  /**
   * The base URLs the repository exports, gathered before any call is read.
   *
   * A separate pass is what cross-module resolution costs: a call in one file
   * cannot be resolved until every file that might declare its base URL has
   * been seen. The substring gate keeps that affordable — a module with no
   * exported constant and no `http` in it anywhere cannot contribute, and that
   * is the overwhelming majority of files.
   */
  async function exportedConstantsIn(ctx: DetectorContext): Promise<Map<string, string>> {
    const perFile: Array<Map<string, string>> = [];
    for (const file of ctx.sourceFiles) {
      if (!/\.[cm]?tsx?$/.test(file)) continue;
      const source = await ctx.read(file);
      if (source === null) continue;
      if (!source.includes('export const') || !source.includes('http')) continue;
      perFile.push(exportedUrlConstants(source));
    }
    return mergeExportedConstants(perFile);
  }

  async function callsIn(ctx: DetectorContext): Promise<HttpCall[]> {
    const exported = await exportedConstantsIn(ctx);
    const calls: HttpCall[] = [];
    for (const file of ctx.sourceFiles) {
      if (!/\.[cm]?tsx?$/.test(file)) continue;
      const source = await ctx.read(file);
      if (source !== null) calls.push(...findHttpCalls(file, source, exported));
    }
    return calls;
  }

  return {
    id: 'http-contract',

    async applies(ctx: DetectorContext): Promise<boolean> {
      // The first outbound call anywhere is the answer, and most repositories
      // have one in the first file that has any.
      //
      // Resolved-or-not, deliberately. Once a base URL can come from another
      // module, whether a call reads standalone no longer predicts whether
      // `detect` can resolve it, and gating on that would skip exactly the
      // repositories this pass was added for. A repository whose calls all stay
      // unreadable costs one walk and finds no hosts, so nothing is fetched.
      for (const file of ctx.sourceFiles) {
        if (!/\.[cm]?tsx?$/.test(file)) continue;
        const source = await ctx.read(file);
        if (source === null) continue;
        if (findHttpCalls(file, source).length > 0) return true;
      }
      return false;
    },

    async detect(ctx: DetectorContext): Promise<{ findings: Finding[]; notes: string[] }> {
      const calls = await callsIn(ctx);
      const hosts = [...new Set(calls.filter((c) => c.resolved && c.host).map((c) => c.host as string))];

      const findings: Finding[] = [];
      const notes: string[] = [];
      // Bounded, because a repository talking to a hundred services should not
      // turn one scan into a hundred resolutions without somebody choosing
      // that. The bound is stated rather than silent — it was silent, while the
      // comment here claimed otherwise, and a scan that checks eight hosts of a
      // hundred and mentions neither the eight nor the ninety-two reads exactly
      // like a clean result for all of them.
      if (hosts.length > maxHosts) {
        notes.push(
          `${hosts.length - maxHosts} other host(s) were not checked: this scan resolves at most ` +
            `${maxHosts}, and ${hosts.length} were found. Raise the budget to check the rest.`,
        );
      }
      for (const host of hosts.slice(0, maxHosts)) {
        const candidates = await options.resolve({ domain: host });
        const spec = candidates[0];
        // No description located means exactly that. The detector reports the
        // call sites it found and says the description was unavailable; it never
        // reports that there is no problem.
        if (!spec) {
          notes.push(`${host}: no API description could be located, so its calls were not checked`);
          continue;
        }

        const check = checkAgainstSpec(calls, host, spec);
        // Said out loud. An empty finding list from a description that could not
        // be trusted is indistinguishable, on screen, from a clean bill of health.
        if (check.note) notes.push(`${host}: ${check.note}`);
        if (check.unresolvedCalls > 0) {
          notes.push(
            `${host}: ${check.unresolvedCalls} call(s) build their URL at runtime and could not be checked`,
          );
        }
        // The description covers part of what this host serves, and calls reach
        // the rest. Saying so is the difference between "checked and clean" and
        // "not described here" — one host commonly serves several APIs, each
        // documented separately.
        if (check.uncovered.length > 0) {
          notes.push(
            `${host}: this description says nothing about ${check.uncovered.join(', ')}, so calls under ${check.uncovered.length === 1 ? 'it were' : 'those were'} not checked`,
          );
        }
        for (const call of check.gone) {
          findings.push({
            id: httpFindingId(host, call.method, call.route ?? ''),
            detector: 'http-contract',
            pkg: host,
            // A wire API has no version pair to bump between. The description is
            // the target, and where it came from is what the reader needs.
            fromVersion: 'in use',
            toVersion: spec.provenance,
            change: {
              path: `${call.method} ${call.route}`,
              kind: 'removed',
              severity: 'breaking',
              confidence: 'medium',
              before: 'present',
              after: null,
              // What was actually checked, stated as such. A published
              // description can omit an endpoint that works — openrouter.ai
              // documents `GET /api/v1/auth/key` while its openapi.json lists
              // only `/auth/keys` — and Emend cannot tell that from a removal.
              // It does not need to: "the description does not describe this"
              // is true either way, and is what a reader can act on. Saying the
              // endpoint is gone claims more than the evidence carries.
              guidance: `not described by ${describeProvenance(spec)}`,
            },
            sites: [{ file: call.file, line: call.line, column: call.column, text: call.text, via: 'import' }],
            confidence: 'medium',
          });
        }

        // What changed since, which is a different question from what is
        // described now. A deprecation and a new capability are both *in* the
        // description, so no reading of it alone can surface either — only a
        // comparison with an earlier version does, and this is where that runs.
        if (options.previous && spec.body && canAssertBreakage(spec)) {
          const before = await options.previous(spec);
          if (!before?.body) {
            notes.push(
              `${host}: no earlier version of its description could be had, so what changed was not compared`,
            );
          } else {
            const diff = diffSpecs(host, before.body, spec.body);
            if (diff.unanalyzable) {
              notes.push(`${host}: ${diff.note ?? 'the earlier description could not be read'}`);
            } else {
              // A route the current description has lost is already reported
              // above, from today's description alone. Reporting it again from
              // the comparison would be one fact twice.
              const reported = new Set(check.gone.map((c) => `${c.method} ${c.route}`));
              for (const hit of matchAgainstDiff(calls, host, diff.changes, before.body)) {
                if (reported.has(hit.change.path)) continue;
                findings.push({
                  id: driftFindingId(host, hit.change.path, hit.change.kind),
                  detector: 'http-contract',
                  pkg: host,
                  // Two dates rather than two versions: a wire API has no
                  // number to bump, and when the description last moved is what
                  // a reader needs to judge the claim.
                  fromVersion: before.updatedAt?.slice(0, 10) ?? 'earlier',
                  toVersion: spec.updatedAt?.slice(0, 10) ?? 'today',
                  change: hit.change,
                  sites: hit.sites,
                  confidence: hit.change.confidence,
                });
              }
            }
          }
        }
      }
      return { findings, notes };
    },
  };
}

export interface DetectorSelection {
  /** Enable the external linters by handing over the adapters to run. */
  lint?: ExternalLintOptions;
  /** Enable the vulnerability detector by handing it a scanner. */
  vulnerabilities?: VulnerabilityOptions;
  /**
   * Enable the contract detector by handing it a resolver.
   *
   * A flag would not be enough. This is the only detector that reaches the
   * network, so switching it on means choosing to make outbound requests to
   * every host in someone's source tree — and that choice belongs to the caller,
   * expressed by supplying the thing that does it.
   */
  contracts?: HttpContractOptions;
}

/** The detectors a scan should run, given what the caller enabled. */
export function detectorsFor(selection: DetectorSelection): Detector[] {
  return [
    versionPinDetector,
    ...(selection.vulnerabilities ? [vulnerabilityDetector(selection.vulnerabilities)] : []),
    ...(selection.lint ? [externalLintDetector(selection.lint)] : []),
    ...(selection.contracts ? [httpContractDetector(selection.contracts)] : []),
  ];
}

/**
 * How each detector's findings are named in a report.
 *
 * Everything used to be filed under "version pins", which was true when there
 * was one detector and became a lie the moment there were two: a reader seeing a
 * vanished Stripe endpoint under that heading learns the wrong thing about where
 * to look.
 */
const DETECTOR_LABELS: Record<string, string> = {
  'version-pin': 'version pins',
  vulnerability: 'vulnerabilities',
  'external-lint': 'lint',
  'http-contract': 'http contracts',
};

export interface DetectorGroup {
  pkg: string;
  findings: Finding[];
  /** Null, always: a detector finding is not an upgrade and has no version pair. */
  fromVersion: null;
  toVersion: null;
}

/** Findings split by the detector that produced them, in first-seen order. */
export function groupByDetector(findings: Finding[]): DetectorGroup[] {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const existing = groups.get(finding.detector);
    if (existing) existing.push(finding);
    else groups.set(finding.detector, [finding]);
  }
  return [...groups].map(([detector, group]) => ({
    // An unnamed detector says what it is rather than borrowing another's name.
    pkg: DETECTOR_LABELS[detector] ?? detector,
    findings: group,
    fromVersion: null,
    toVersion: null,
  }));
}

/**
 * Run every detector that applies, keeping what succeeds and naming what does not.
 *
 * `applies` is a precondition rather than a hint: a detector that has to read
 * the whole repository before discovering it has no work is one nobody registers.
 */
export async function runDetectors(
  detectors: Detector[],
  ctx: DetectorContext,
): Promise<DetectorRun> {
  const findings: Finding[] = [];
  const notes: string[] = [];
  const failures: DetectorFailure[] = [];

  for (const detector of detectors) {
    try {
      if (!(await detector.applies(ctx))) continue;
      const result = await detector.detect(ctx);
      findings.push(...result.findings);
      if (result.notes) notes.push(...result.notes);
    } catch (err) {
      failures.push({ detector: detector.id, reason: (err as Error).message });
    }
  }

  return { findings, notes, failures };
}

function vulnFindingId(name: string, from: string, ids: string[]): string {
  return createHash('sha256')
    .update(`vulnerability|${name}|${from}|${[...ids].sort().join(',')}`)
    .digest('hex')
    .slice(0, 12);
}

/**
 * Every package this repository imports, and where.
 *
 * Built once over the whole source tree rather than once per package. The
 * per-package version was O(files × packages) — on a repository with 19,000
 * files and 28 vulnerable packages that is half a million parses. One pass is
 * 19,000, measured at nine seconds, and it answers every lookup for free.
 */
export async function indexImports(
  files: string[],
  read: (file: string) => Promise<string | null>,
): Promise<Map<string, CallSite[]>> {
  const index = new Map<string, CallSite[]>();

  for (const file of files) {
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    const source = await read(file);
    if (source === null) continue;
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);

    const record = (node: ts.Node, specifier: string): void => {
      const pkg = packageOfSpecifier(specifier);
      if (!pkg) return;
      const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      const sites = index.get(pkg) ?? [];
      sites.push({
        file,
        line: line + 1,
        column: character + 1,
        text: node.getText(sf).split('\n')[0]?.slice(0, 120) ?? '',
        via: 'import',
      });
      index.set(pkg, sites);
    };

    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
        record(node, node.moduleSpecifier.text);
      } else if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'require' &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        record(node, node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return index;
}

export interface VulnerabilityOptions {
  /** Injected: this detector reaches the network, and that is the caller's call. */
  scan: (packages: InstalledPackage[]) => Promise<VulnerablePackage[]>;
  /**
   * Optional second opinion: numeric severity, and how likely exploitation is.
   *
   * Ordering without it is arbitrary, and arbitrary ordering on a list of forty
   * findings means the one under active exploitation is as likely to be
   * fortieth as first.
   */
  enrich?: (advisoryIds: string[]) => Promise<Map<string, AdvisoryFacts>>;
}

/**
 * Known vulnerabilities in the installed tree, with what one bump would fix.
 *
 * **One finding per package, not per advisory.** `axios@0.21.0` alone carries
 * twenty-five, measured, and a finding each would bury every other finding in
 * the scan under a single dependency — a report nobody finishes is worth less
 * than none. It is also what the remediation actually is: one bump, verified
 * once, clearing all of them.
 *
 * **Reachability is evidence, never a filter.** A package the repository
 * imports carries those imports as its call sites, which is the thing `npm
 * audit` cannot say. A package nothing imports carries its lockfile entry
 * instead — it is three levels down and still runs in this process, because its
 * parent calls it, so suppressing it would be Emend asserting something it has
 * not established.
 */
export function vulnerabilityDetector(options: VulnerabilityOptions): Detector {
  // runDetectors calls applies() immediately before detect() on this same
  // object, so the claiming inventories are cached here for detect() to reuse
  // instead of re-probing every inventory's applies() — each of which parses
  // a lockfile — a second time. A caller that invokes detect() on its own
  // (tests here do) just computes it fresh; nothing relies on applies() having
  // run first. Scoped to this Detector instance rather than to repoDir:
  // detectorsFor builds a fresh vulnerabilityDetector() per scan, so this
  // cache is born and discarded with the scan and can never outlive it to see
  // a lockfile a later bumpDependency changed.
  let claiming: EcosystemInventory[] | null = null;
  async function claimingInventories(repoDir: string): Promise<EcosystemInventory[]> {
    if (claiming === null) claiming = await inventoriesFor(repoDir);
    return claiming;
  }

  return {
    id: 'vulnerability',

    async applies(ctx: DetectorContext): Promise<boolean> {
      // Any ecosystem that claims this repository, not only npm. Gating on one
      // lockfile is how a whole language went unscreened while looking checked.
      return (await claimingInventories(ctx.repoDir)).length > 0;
    },

    async detect(ctx: DetectorContext): Promise<{ findings: Finding[]; notes: string[] }> {
      const notes: string[] = [];
      const inventories = await claimingInventories(ctx.repoDir);
      const packages: InstalledPackage[] = [];
      for (const inventory of inventories) {
        const result = await inventory.read(ctx.repoDir);
        if (result.unsupported) {
          notes.push(`${result.unsupported} could not be read, so its packages were not checked`);
        }
        packages.push(...result.packages);
      }
      if (packages.length === 0) return { findings: [], notes };

      let vulnerable: VulnerablePackage[];
      try {
        vulnerable = await options.scan(packages);
      } catch (err) {
        // Said, not swallowed. An empty finding list from a scan that never ran
        // renders as a clean repository.
        notes.push(
          `the vulnerability database could not be reached, so ${packages.length} installed package(s) were not checked — ${(err as Error).message}`,
        );
        return { findings: [], notes };
      }

      // Enrichment is optional and its absence must not change what is
      // reported — only the order, and how much a reader is told about urgency.
      let facts = new Map<string, AdvisoryFacts>();
      if (options.enrich) {
        try {
          facts = await options.enrich(vulnerable.flatMap((p) => p.vulnerabilities.map((v) => v.id)));
        } catch {
          notes.push('advisory severity and exploitation data were unavailable, so findings are unranked');
        }
      }
      const ordered = facts.size > 0 ? rankVulnerable(vulnerable, facts) : vulnerable;

      // One pass over the source tree, then a lookup per package.
      const imports = await indexImports(ctx.sourceFiles, ctx.read);

      // One manifest parse per claiming inventory, not one per non-imported
      // package: manifestSites re-reads and re-parses a whole lockfile, and
      // asking per package turned a 50,000-package lockfile's one-time parse
      // cost into a per-finding one.
      const sitesByKey = new Map<string, CallSite>();
      for (const inventory of inventories) {
        const owned = ordered.filter((p) => p.ecosystem === inventory.osvEcosystem);
        if (owned.length === 0) continue;
        for (const [key, site] of await inventory.manifestSites(ctx.repoDir, owned)) {
          // First-registered inventory wins a shared OSV ecosystem key,
          // matching the uniqueness assumption documented on osvEcosystem.
          if (!sitesByKey.has(key)) sitesByKey.set(key, site);
        }
      }

      const findings: Finding[] = [];

      for (const pkg of ordered) {
        const target = remediationTarget(pkg);

        const sites: CallSite[] = [...(imports.get(pkg.name) ?? [])];
        const imported = sites.length > 0;
        if (!imported) {
          // Absent when no registered inventory understands this package's
          // OSV ecosystem, or when the owning inventory had nothing to cite
          // for this repository at all (no lockfile present, or it could not
          // be read) — the finding stands without a manifest site rather
          // than with a fabricated one.
          const site = sitesByKey.get(`${pkg.name}@${pkg.version}`);
          if (site) sites.push(site);
        }

        // Deduplicated: separate advisories routinely alias the same CVE, and
        // listing it twice reads as two problems.
        const named = [...new Set(pkg.vulnerabilities.map((v) => v.cve ?? v.id))].join(', ');
        const reach = imported
          ? `imported at ${sites.length} site(s) in this repository`
          : 'not imported from this repository’s source — it runs because a dependency calls it';
        const leaves =
          target.leaves.length > 0
            ? ` ${target.leaves.length} has no published fix and survives the upgrade: ${target.leaves.join(', ')}.`
            : '';
        // The urgency line, when anybody has assessed it. EPSS is stated as a
        // percentile because the raw probability reads as reassuringly small —
        // 0.07 is the 94th percentile of all CVEs.
        const worst = pkg.vulnerabilities
          .map((v) => facts.get(v.id))
          .filter((f): f is AdvisoryFacts => f !== undefined)
          .sort((a, b) => (b.epssPercentile ?? -1) - (a.epssPercentile ?? -1))[0];
        const urgency =
          worst?.epssPercentile !== undefined && worst?.epssPercentile !== null
            ? ` Exploitation likelihood: ${ordinal(Math.round(worst.epssPercentile * 100))} percentile${worst.severity ? ` (${worst.severity})` : ''}.`
            : worst?.severity
              ? ` Severity: ${worst.severity}.`
              : '';

        const guidance = target.version
          ? `${named}. Upgrading to ${target.version} clears ${target.clears} of ${pkg.vulnerabilities.length}.${leaves}${urgency} ${reach}.`
          : `${named}. No published fix, so no upgrade is proposed.${urgency} ${reach}.`;

        findings.push({
          id: vulnFindingId(pkg.name, pkg.version, pkg.vulnerabilities.map((v) => v.id)),
          detector: 'vulnerability',
          pkg: pkg.name,
          fromVersion: pkg.version,
          // Unfixable stays at the installed version rather than naming a
          // target that does not exist.
          toVersion: target.version ?? pkg.version,
          change: {
            path: pkg.vulnerabilities[0]?.id ?? pkg.name,
            kind: 'version-drift',
            severity: 'vulnerability',
            confidence: 'high',
            before: pkg.version,
            after: target.version,
            guidance,
          },
          sites,
          // OSV states the affected range and the version is read from the
          // lockfile. Neither is a guess.
          confidence: 'high',
        });
      }
      return { findings, notes };
    },
  };
}

function lintFindingId(file: string, code: string, line: number): string {
  return createHash('sha256').update(`lint|${file}|${code}|${line}`).digest('hex').slice(0, 12);
}

export interface ExternalLintOptions {
  /** Injected: these are external binaries, and running them is the caller's call. */
  adapters: LintAdapter[];
}

/**
 * What hadolint and shellcheck object to in this repository.
 *
 * A Dockerfile and a shell script are as much a part of "does this still work"
 * as the TypeScript, and neither has a type checker. Each finding carries the
 * file and line the tool reported, so it has a call site like everything else
 * here — and `severity` is `lint`, kept out of the breaking count.
 *
 * A tool that is not installed is reported as absent rather than passing over
 * in silence. Asking for a check and quietly not getting one is the failure this
 * codebase spends most of its effort avoiding.
 */
export function externalLintDetector(options: ExternalLintOptions): Detector {
  return {
    id: 'external-lint',

    async applies(ctx: DetectorContext): Promise<boolean> {
      // Purely a question about filenames, so it costs no process.
      return options.adapters.some((a) => a.applies(ctx.sourceFiles).length > 0);
    },

    async detect(ctx: DetectorContext): Promise<{ findings: Finding[]; notes: string[] }> {
      const findings: Finding[] = [];
      const notes: string[] = [];

      for (const adapter of options.adapters) {
        const files = adapter.applies(ctx.sourceFiles);
        if (files.length === 0) continue;

        const status = await adapter.available();
        if (!status.ok) {
          notes.push(`${files.length} file(s) were not linted: ${status.reason}`);
          continue;
        }

        const { findings: raw, error } = await adapter.run(ctx.repoDir, files);
        if (error) {
          notes.push(`${adapter.id} could not lint ${files.length} file(s) — ${error}`);
          continue;
        }

        // The offending line itself, so a site shows the code rather than
        // repeating the message printed directly above it.
        const lines = new Map<string, string[]>();
        for (const file of new Set(raw.map((f) => f.file))) {
          const source = await ctx.read(file);
          if (source !== null) lines.set(file, source.split('\n'));
        }

        for (const f of raw) {
          findings.push({
            id: lintFindingId(f.file, f.code, f.line),
            detector: 'external-lint',
            pkg: f.tool,
            fromVersion: f.level,
            toVersion: f.level,
            change: {
              path: f.code,
              kind: 'lint',
              severity: 'lint',
              confidence: 'high',
              before: f.level,
              after: null,
              guidance: f.message,
            },
            // The tool gave a file and a line, which is exactly the evidence
            // every other finding here is required to carry.
            sites: [
              {
                file: f.file,
                line: f.line,
                column: f.column,
                text: (lines.get(f.file)?.[f.line - 1] ?? '').trim().slice(0, 120),
                via: 'import',
              },
            ],
            // The tool's own judgement, reported rather than re-litigated. What
            // Emend cannot know is whether this particular rule matters here.
            confidence: 'medium',
          });
        }
      }
      return { findings, notes };
    },
  };
}
