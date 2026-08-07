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
import { readLockfile } from './lockfile.ts';
import { packageOfSpecifier } from './callsites.ts';
import { remediationTarget, type InstalledPackage, type VulnerablePackage } from './osv.ts';
import { ordinal, rankVulnerable, type AdvisoryFacts } from './advisory.ts';
import { extractPins, findPinConflicts, resolvedVersions, PIN_FILES } from './pins.ts';
import { checkAgainstSpec, findHttpCalls, type HttpCall } from './httpsites.ts';
import { describeProvenance, type SpecCandidate } from './specs.ts';
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

/** Everything this detector needs beyond the ordinary context. */
export interface HttpContractOptions {
  resolve: (vendor: { domain: string }) => Promise<SpecCandidate[]>;
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

  async function callsIn(ctx: DetectorContext): Promise<HttpCall[]> {
    const calls: HttpCall[] = [];
    for (const file of ctx.sourceFiles) {
      if (!/\.[cm]?tsx?$/.test(file)) continue;
      const source = await ctx.read(file);
      if (source !== null) calls.push(...findHttpCalls(file, source));
    }
    return calls;
  }

  return {
    id: 'http-contract',

    async applies(ctx: DetectorContext): Promise<boolean> {
      // Cheap enough to be a precondition: the first resolved outbound call
      // anywhere is the answer, and most repositories have one in the first file
      // that has any.
      for (const file of ctx.sourceFiles) {
        if (!/\.[cm]?tsx?$/.test(file)) continue;
        const source = await ctx.read(file);
        if (source === null) continue;
        if (findHttpCalls(file, source).some((c) => c.resolved)) return true;
      }
      return false;
    },

    async detect(ctx: DetectorContext): Promise<{ findings: Finding[]; notes: string[] }> {
      const calls = await callsIn(ctx);
      const hosts = [...new Set(calls.filter((c) => c.resolved && c.host).map((c) => c.host as string))];

      const findings: Finding[] = [];
      const notes: string[] = [];
      // Bounded, and the bound is stated rather than silent: a repository
      // talking to thirty services should not turn one scan into thirty
      // resolutions without somebody choosing that.
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
              guidance: `not in ${describeProvenance(spec)}`,
            },
            sites: [{ file: call.file, line: call.line, column: call.column, text: call.text, via: 'import' }],
            confidence: 'medium',
          });
        }
      }
      return { findings, notes };
    },
  };
}

export const DETECTORS: Detector[] = [versionPinDetector];

export interface DetectorSelection {
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

/** Where a source file imports a package, so a vulnerability can point at it. */
function importSites(file: string, source: string, pkg: string): CallSite[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
  const sites: CallSite[] = [];

  const record = (node: ts.Node, specifier: string): void => {
    if (packageOfSpecifier(specifier) !== pkg) return;
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    sites.push({
      file,
      line: line + 1,
      column: character + 1,
      text: node.getText(sf).split('\n')[0]?.slice(0, 120) ?? '',
      via: 'import',
    });
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
  return sites;
}

/** The lockfile line declaring a package, so a transitive finding still has evidence. */
function lockfileSite(lockfile: string, installPath: string): CallSite {
  const lines = lockfile.split('\n');
  const index = lines.findIndex((l) => l.includes(`"${installPath}"`));
  return {
    file: 'package-lock.json',
    line: index === -1 ? 1 : index + 1,
    column: 1,
    text: installPath,
    via: 'import',
  };
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
  return {
    id: 'vulnerability',

    async applies(ctx: DetectorContext): Promise<boolean> {
      // The installed tree is the input. Without one there is nothing to ask
      // about, and answering that must not cost a request.
      const lock = await readLockfile(ctx.repoDir);
      return lock.tree.size > 0;
    },

    async detect(ctx: DetectorContext): Promise<{ findings: Finding[]; notes: string[] }> {
      const notes: string[] = [];
      const lock = await readLockfile(ctx.repoDir);
      if (lock.unsupported) {
        notes.push(`${lock.unsupported} could not be read, so its packages were not checked`);
      }

      // The whole tree, not the direct dependencies. Most vulnerabilities in a
      // real repository are transitive, and screening only what package.json
      // names would miss the majority of them.
      const byName = new Map<string, string>();
      const packages: InstalledPackage[] = [];
      for (const entry of lock.tree.values()) {
        const key = `${entry.name}@${entry.version}`;
        if (byName.has(key)) continue;
        byName.set(key, entry.installPath);
        packages.push({ name: entry.name, ecosystem: 'npm', version: entry.version });
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

      const lockRaw = (await ctx.read('package-lock.json')) ?? '';
      const findings: Finding[] = [];

      for (const pkg of ordered) {
        const target = remediationTarget(pkg);

        const sites: CallSite[] = [];
        for (const file of ctx.sourceFiles) {
          if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
          const source = await ctx.read(file);
          if (source !== null) sites.push(...importSites(file, source, pkg.name));
        }
        const imported = sites.length > 0;
        if (!imported) {
          sites.push(lockfileSite(lockRaw, byName.get(`${pkg.name}@${pkg.version}`) ?? pkg.name));
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
