#!/usr/bin/env node
/**
 * Emend command line.
 *
 * Commands are deliberately shallow — the interesting logic lives in the pipeline
 * modules, and this file is just argument handling and human-readable output.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, cp, access, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { scanRepo } from './analyze.ts';
import { readRepo } from './inventory.ts';
import { reintroduced } from './remediate.ts';
import { offersPagination } from './httpsites.ts';
import { fixFinding, needsSourceRepair, fixFreshness, fixLint, fixPackage, fixPins, fixVulnerability } from './fix.ts';
import { Store } from './store.ts';
import { renderPrBody, renderPrTitle, createPullRequest, branchSlug, summarisePr } from './pr.ts';
import {
  assistantText,
  contractReviewPrompt,
  parseContractFindings,
  renderContractFindings,
  type ContractFinding,
  renderReviewFindings,
  reviewSession,
} from './reviewharness.ts';
import { startServer } from './server.ts';
import { verificationPassed } from './verify.ts';
// `emend models` lists what a provider serves, which is the one place the CLI
// legitimately knows a provider exists. Everything that asks a model to *work*
// goes through the harness.
import { PROVIDERS, resolveLlmConfig } from './llm/providers.ts';
import { serve as serveMcp } from './mcp.ts';
import {
  openCodeHarness,
  drivingHarness,
  drivePrompt,
  driveContractPrompt,
  harnessPermitted,
  asker,
  type Harness,
} from './harness.ts';
import { resolveSpec, httpFetcher } from './specfetch.ts';
import { parseSpec } from './specdiff.ts';
import { behindCurrent } from './pins.ts';
import { previousVersion } from './github.ts';
import { scanPackages, goSymbolRecord } from './osv.ts';
import { goSymbolSites, symbolTargets } from './goreach.ts';
import { LINT_ADAPTERS } from './lint.ts';
import { enrichAdvisories } from './advisory.ts';
import type { VulnerabilityOptions } from './detectors.ts';
import { canAssertBreakage, githubOrgs, orgFor, type SpecCandidate } from './specs.ts';
import { listModels } from './llm/client.ts';
import {
  loadCases,
  materialiseCase,
  runCase,
  scoreCase,
  summarise,
  renderSummary,
  type CaseOutcome,
} from './eval.ts';
import type { CallSite, Finding, ScanReport } from './types.ts';

const execFileAsync = promisify(execFile);

// Credentials live in `.env` during development. Node loads it natively, so this
// costs no dependency. Real environment variables already set are not
// overwritten, which keeps CI and production authoritative over a stray file.
try {
  process.loadEnvFile(path.resolve(process.cwd(), '.env'));
} catch {
  /* no .env, which is the normal case outside development */
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s: string) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
  magenta: (s: string) => (useColor ? `\x1b[35m${s}\x1b[0m` : s),
};

interface Args {
  command: string;
  positional: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === undefined) continue;
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq !== -1) {
        flags.set(token.slice(2, eq), token.slice(eq + 1));
      } else {
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags.set(token.slice(2), next);
          i++;
        } else {
          flags.set(token.slice(2), true);
        }
      }
    } else {
      positional.push(token);
    }
  }
  return { command, positional, flags };
}

/**
 * The harness escalation, when one was asked for.
 *
 * `--harness` alone leaves the model to opencode's own configuration;
 * `--harness=<provider/model>` pins one. Pinning is the mitigation for the
 * reproducibility cost the design spec prices: a regression that cannot be
 * attributed to a model is a regression nobody can chase.
 */
function harnessFrom(args: Args): Harness | undefined {
  const flag = args.flags.get('harness');
  if (flag === undefined || flag === false) return undefined;
  return openCodeHarness(typeof flag === 'string' ? { model: flag } : {});
}

/**
 * Whether the model may take part, which it may unless told otherwise.
 *
 * `--agent` was opt-in, and the default it implied was the wrong one: a finding
 * the deterministic planner declines is a finding a person fixes by hand, so
 * every run without the flag quietly delivered the linter rather than the tool.
 * `--no-agent` keeps the deterministic run available for anyone who needs the
 * build offline or reproducible.
 *
 * `--agent` still parses, and now says nothing, so no existing invocation
 * breaks on the change.
 */
function agentAllowed(args: Args): boolean {
  return args.flags.get('no-agent') !== true;
}

/**
 * The read-only repo-wide review, which runs unless it is turned off.
 *
 * A model with read access to the checkout, not a coding harness. opencode was
 * the obvious choice and was wrong twice: it resolves its model from the host's
 * own config — on a Copilot-authenticated machine that silently meant Claude,
 * contrary to running on open weights — and its read-only mode was configuration
 * to be verified afterwards rather than a capability it lacked. Here there is no
 * write tool to deny.
 *
 * On by default because it is the only pass that reads the *consequence* of a
 * change rather than its text. Proven on a redirected call whose response shape
 * was unchanged and whose rows were not: it followed the call into its consumer
 * and reported that a broadcast would now reach people outside the audience it
 * named. A verified build says nothing about that, and neither does a diff.
 *
 * `--review=<model>` pins one; `--no-review` skips it.
 */
function reviewHarnessFrom(args: Args): Harness | undefined {
  const flag = args.flags.get('review');
  if (args.flags.get('no-review') === true) return undefined;
  if (flag === false) return undefined;
  // A separate session from any repair harness, deliberately. A model reviewing
  // its own work argues for it; one that never saw the reasoning has only the
  // code. `--review=<provider/model>` pins the reviewer independently.
  return openCodeHarness({
    readOnly: true,
    // Bash, but no edit. Measured: the review found nothing until it could run
    // `ls` — which was the first thing the successful direct run did. Told to
    // open files but given no way to discover which exist, it has only the diff,
    // and duplication is exactly what the diff cannot show.
    //
    // The read-only guarantee does not rest on this permission. It rests on
    // comparing the workspace before and after and discarding the findings of a
    // session that changed anything — evidence rather than configuration. What
    // does widen is reach outside the checkout: `webfetch` is denied but bash
    // could still curl, so this path stays blocked for untrusted repositories.
    allowBash: true,
    ...(typeof flag === 'string' ? { model: flag } : {}),
  });
}

/**
 * Contract checking, when it was asked for.
 *
 * Returns the resolver rather than a boolean, because handing over the thing
 * that makes outbound requests is what "yes, go and ask the vendors" means.
 * `--contracts=<dir>` puts the description cache somewhere durable; a hosted
 * scan wants that, a one-off does not care.
 */
/**
 * The API version each pinned vendor publishes, where a description says so.
 *
 * Reuses the resolver `--contracts` already hands over rather than adding a
 * second way to reach a vendor, so provenance and currency are decided in one
 * place. A pin is only judged against a description Emend may assert from —
 * being behind is a claim about somebody's code, and a stale mirror cannot
 * support it.
 */
async function publishedVersions(
  report: ScanReport,
  contracts: { resolve: (v: { domain: string }) => Promise<SpecCandidate[]> } | undefined,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (!contracts || report.apiVersionPins.length === 0) return found;

  // Unattributed pins are skipped rather than guessed at. A pin whose owner the
  // source never named has no vendor to look up, and picking one would compare
  // it against a different company's published version — which is the failure
  // the vendor list used to cause, not a smaller version of it.
  const subjects = report.apiVersionPins.map((p) => p.subject).filter((s) => s !== null);
  for (const subject of new Set(subjects)) {
    // Where the vendor lives is derived, not listed. A table of
    // subject-to-domain would need an entry before Emend could say anything
    // about a vendor, which makes every new one a code change — and the
    // resolver already decides whether a domain is real: it walks the
    // provider's own origin, their APIs.json, their GitHub organisation, and
    // refuses anything it cannot trace back to them. So the candidates are
    // offered and the resolver is left to reject the ones that are nothing.
    for (const domain of [`api.${subject}.com`, `${subject}.com`, `api.${subject}.io`, `${subject}.io`]) {
      try {
        const spec = (await contracts.resolve({ domain }))[0];
        if (!spec?.body || !canAssertBreakage(spec, Date.now())) continue;
        const doc = parseSpec(spec.body) as { info?: { version?: unknown } } | null;
        const version = doc?.info?.version;
        if (typeof version === 'string' && version !== '') {
          found.set(subject, version);
          break;
        }
      } catch {
        // Unreachable is unchecked, which the caller's unchanged line says.
      }
    }
  }
  return found;
}

function contractsFrom(args: Args): {
  resolve: (v: { domain: string }) => Promise<SpecCandidate[]>;
  previous?: (c: SpecCandidate) => Promise<SpecCandidate | null>;
  maxHosts?: number;
} | undefined {
  const flag = args.flags.get('contracts');
  if (flag === undefined || flag === false) return undefined;
  const cacheDir =
    typeof flag === 'string' ? flag : path.join(os.tmpdir(), 'emend-specs');
  const fetch = httpFetcher();

  // GitHub is the only source that can yield a description Emend may assert
  // breakage from, so it is worth reaching for — but sixty unauthenticated
  // requests an hour is exhausted by a handful of vendors, measured. A token
  // raises it to five thousand.
  const token = process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN'];
  // Named by the operator, per vendor, when no automatic check can connect the
  // two. A scan reaches many hosts, so one organisation for all of them would
  // search the wrong repositories and credit the wrong provider's file.
  const orgFlag = args.flags.get('github-org');
  const orgs = typeof orgFlag === 'string' ? githubOrgs(orgFlag) : new Map<string, string>();

  // Comparing against an earlier version is its own opt-in, because it is its
  // own outbound cost — two more requests per vendor — and it answers a
  // different question: not "is this route still described" but "what changed,
  // and does any of it reach this code". Deprecations and new capabilities are
  // only visible that way, since both are still in the description.
  const sinceFlag = args.flags.get('since');
  const sinceDays = typeof sinceFlag === 'string' ? Number(sinceFlag) : sinceFlag === true ? 365 : 0;
  const previous =
    Number.isFinite(sinceDays) && sinceDays > 0
      ? async (candidate: SpecCandidate): Promise<SpecCandidate | null> => {
          const at = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
          const found = await previousVersion(fetch, candidate.url, at, token ? { token } : {});
          return found
            ? { ...candidate, url: found.url, body: found.body, updatedAt: found.updatedAt }
            : null;
        }
      : undefined;

  const maxFlag = args.flags.get('max-hosts');
  const maxHosts = typeof maxFlag === 'string' && Number.isFinite(Number(maxFlag)) ? Number(maxFlag) : undefined;

  return {
    ...(previous ? { previous } : {}),
    ...(maxHosts && maxHosts > 0 ? { maxHosts } : {}),
    resolve: (vendor) => {
      const org = orgFor(vendor.domain, orgs);
      return resolveSpec(
        { ...vendor, ...(org ? { org } : {}) },
        {
          fetch,
          cacheDir,
          github: { ...(token ? { token } : {}), ...(org ? { org } : {}) },
        },
      );
    },
  };
}

/**
 * Vulnerability scanning, when it was asked for.
 *
 * The scanner is handed over rather than a flag set, for the same reason the
 * spec resolver is: enabling it means choosing to send this repository's
 * dependency list to a third party, and that belongs to whoever supplies the
 * thing that sends it. OSV needs no key and imposes no rate limit.
 */
function vulnerabilitiesFrom(args: Args): VulnerabilityOptions | undefined {
  const flag = args.flags.get('vulns');
  if (flag === undefined || flag === false) return undefined;
  const fetch = httpFetcher({ timeoutMs: 30_000 });
  // GitHub's advisory endpoint carries the numeric severity and the exploitation
  // estimate OSV does not. Unauthenticated it allows sixty requests an hour
  // across everything Emend does, so a token matters here too.
  const token = process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN'];
  return {
    scan: (packages) => scanPackages(fetch, packages),
    enrich: (ids) => enrichAdvisories(fetch, ids, { ...(token ? { token } : {}) }),
    // Go only. The GHSA record carries no symbols; the GO-xxxx record it aliases
    // does, so this is one more request per advisory in exchange for knowing
    // whether the vulnerable *function* is reached rather than only the module.
    goSymbols: async (pkg, ctx) => {
      const sites: CallSite[] = [];
      for (const vuln of pkg.vulnerabilities) {
        const record = await goSymbolRecord(fetch, vuln.aliases);
        if (!record) continue;
        for (const target of symbolTargets(record, pkg.name)) {
          for (const file of ctx.sourceFiles) {
            if (!file.endsWith('.go')) continue;
            const source = await ctx.read(file);
            if (source !== null) sites.push(...goSymbolSites(file, source, target));
          }
        }
      }
      return sites;
    },
  };
}

/** The external linters, when they were asked for. */
function lintFrom(args: Args): { adapters: typeof LINT_ADAPTERS } | undefined {
  return args.flags.get('lint') === undefined || args.flags.get('lint') === false
    ? undefined
    : { adapters: LINT_ADAPTERS };
}

function severityLabel(sev: string): string {
  if (sev === 'breaking') return c.red('breaking');
  if (sev === 'vulnerability') return c.red('vulnerable');
  if (sev === 'lint') return c.yellow('lint');
  if (sev === 'freshness') return c.dim('behind');
  if (sev === 'deprecation') return c.yellow('deprecated');
  return c.dim(sev);
}

/**
 * The API version each pinned vendor currently publishes, where it could be
 * established. Keyed by the subject `pins.ts` names — `stripe`, `anthropic`.
 */
type CurrentVersions = Map<string, string>;

function printScan(report: ScanReport, showAll: boolean, current: CurrentVersions = new Map()): void {
  const { counts } = report;
  console.log('');
  console.log(c.bold(`  Emend scan — ${report.repo}`));
  console.log('');

  const analyzed = report.packages.filter((p) => p.status === 'analyzed');
  const withFindings = analyzed.filter((p) => p.findings.length > 0);

  for (const p of report.packages) {
    // A package with nothing to say stays hidden — there are hundreds of them
    // and they are the reason this filter exists. A package that *declined to
    // say something* is different: its note is the only record that a surface
    // was truncated, or that a symbol was treated as moved rather than removed.
    // Hiding that is how a finding disappears between two runs with no
    // explanation, which is what this filter was doing to the one case where it
    // mattered most — a package whose only finding had just been suppressed.
    if (p.status === 'analyzed' && p.findings.length === 0 && !p.note && !showAll) continue;
    if (p.status === 'up-to-date' && !showAll) continue;

    // A detector's findings are not an upgrade and have no version pair, so the
    // arrow would render as "? → ?" and read like missing data.
    const header =
      p.fromVersion || p.toVersion
        ? `  ${c.bold(p.pkg)} ${c.dim(`${p.fromVersion ?? '?'} → ${p.toVersion ?? '?'}`)}`
        : `  ${c.bold(p.pkg)}`;
    if (p.status !== 'analyzed') {
      console.log(`${header}  ${c.yellow(`[${p.status}]`)}`);
      if (p.note) console.log(`    ${c.dim(p.note)}`);
      continue;
    }

    console.log(header);
    // An analyzed package has notes too, and they are the ones that say what
    // was *not* claimed: a surface truncated before its end, a symbol reported
    // as moved rather than removed. This branch computed them, carried them
    // through the report, and dropped them here — so a finding that vanished
    // between two runs did so without explanation, which is the silence the
    // rest of this tier exists to prevent.
    if (p.note) console.log(`    ${c.dim(p.note)}`);
    for (const f of p.findings) {
      console.log(
        `    ${severityLabel(f.change.severity)} ${c.cyan(f.change.path)} ${c.dim(`(${f.change.kind}, ${f.confidence} confidence, id ${f.id})`)}`,
      );
      // The most useful line a vulnerability finding carries: which advisories,
      // what one bump clears, and what it leaves behind.
      if (f.change.guidance) console.log(c.dim(`      ${f.change.guidance}`));
      for (const s of f.sites) {
        console.log(`      ${c.dim('→')} ${s.file}:${s.line}:${s.column}  ${c.dim(s.text)}`);
      }
    }
    if (p.unlocatedBreaking > 0) {
      console.log(
        `    ${c.dim(`+ ${p.unlocatedBreaking} other breaking change(s) in this upgrade do not appear anywhere in your code`)}`,
      );
    }
  }

  if (withFindings.length === 0) {
    // Green only when there is nothing else to say. A scan that located a
    // vendor's description and could not trust it has not established that the
    // codebase is fine, and printing an all-clear above the caveats explaining
    // why is how a reader takes the first line and stops.
    console.log(
      report.warnings.length === 0
        ? c.green('  No findings: no tracked API change intersects this codebase.')
        : c.yellow('  No findings — but see the caveats below before reading that as clean.'),
    );
  }

  // Only the ones nothing can arbitrate. A drift with an authority is a finding
  // now, printed with every other finding above; repeating it here was the
  // duplication the seam exists to remove.
  const unresolvable = report.pinConflicts.filter((cf) => cf.expected === null);
  if (unresolvable.length > 0) {
    console.log('');
    console.log(`  ${c.bold('Version pins that disagree, with nothing to arbitrate')}`);
    for (const conflict of unresolvable) {
      console.log(`    ${c.yellow('conflict')}   ${conflict.subject} — no declared intent, so this one needs a human`);
      for (const pin of conflict.pins) {
        console.log(c.dim(`      → ${pin.file}:${pin.line}  ${pin.text}`));
      }
    }
  }

  // Observations, not findings. Emend can see the pin and cannot know whether it
  // is stale — that needs a vendor registry it does not have — so this block
  // states what is pinned and where, and claims nothing about whether it should
  // change. It sits apart from the counts for the same reason.
  if (report.apiVersionPins.length > 0) {
    console.log('');
    console.log(`  ${c.bold('Wire API versions pinned in source')}`);
    for (const pin of report.apiVersionPins) {
      // Named as unowned rather than left blank. A reader who sees a version
      // with no vendor beside it fills the gap in themselves, and the gap is
      // the finding: the source never said whose API this is.
      const who = pin.subject ?? 'unattributed';
      console.log(`    ${c.cyan(who)} ${pin.version}`);
      console.log(c.dim(`      → ${pin.file}:${pin.line}  ${pin.text}`));
    }
    let judged = 0;
    for (const pin of report.apiVersionPins) {
      const published = pin.subject === null ? undefined : current.get(pin.subject);
      if (published === undefined) continue;
      const behind = behindCurrent(pin.version, published);
      if (behind === null) continue;
      judged++;
      console.log(
        behind
          ? c.yellow(`    ${pin.subject} publishes ${published}; this pin is behind it`)
          : c.dim(`    ${pin.subject} publishes ${published}; this pin is current`),
      );
    }
    if (judged < report.apiVersionPins.length) {
      // Unchanged for the ones that could not be judged, and it is the honest
      // line: a description's `info.version` is the *API's* version only where
      // the vendor versions its API that way. OpenAI publishes `2.3.0`, which
      // versions the document.
      console.log(
        c.dim('    The rest are reported, not checked: the current version is the vendor’s to publish.'),
      );
    }
  }

  console.log('');
  console.log(
    `  ${c.bold('Summary')}  ${counts.breaking} breaking · ${counts.deprecation} deprecated · ${counts.callSites} call site(s)`,
  );
  if (counts.pinConflicts > 0) {
    console.log(c.dim(`           ${counts.pinConflicts} version pin(s) disagree`));
  }
  // Its own line, not folded into the headline. A CVE is not an API change, and
  // a reader who sees two vulnerabilities listed above a "0 breaking" summary
  // reasonably concludes the summary is broken.
  if (counts.vulnerabilities > 0) {
    console.log(
      c.dim(`           ${counts.vulnerabilities} package(s) with known vulnerabilities`),
    );
  }
  if (counts.lint > 0) {
    console.log(c.dim(`           ${counts.lint} lint finding(s) in Dockerfiles and shell scripts`));
  }
  if (counts.freshness > 0) {
    console.log(
      c.dim(`           ${counts.freshness} package(s) behind latest with nothing that would break`),
    );
  }
  console.log(
    c.dim(
      `           ${counts.packagesAnalyzed} package(s) analyzed, ${counts.packagesSkipped} skipped (skipped ≠ clean)`,
    ),
  );

  if (report.warnings.length > 0) {
    console.log('');
    console.log(`  ${c.yellow('Caveats')}`);
    for (const w of report.warnings) console.log(`    ${c.dim('•')} ${w}`);
  }
  console.log('');
}

async function cmdScan(args: Args): Promise<number> {
  const repoDir = path.resolve(args.positional[0] ?? '.');
  const only = typeof args.flags.get('only') === 'string'
    ? String(args.flags.get('only')).split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;

  const repo = await readRepo(repoDir);
  const contracts = contractsFrom(args);
  const vulnerabilities = vulnerabilitiesFrom(args);
  // What this repository has already had fixed, so a package that slipped back
  // is reported as a reintroduction rather than as something newly discovered.
  const previouslyFixed = new Store();
  const fixedBefore = previouslyFixed.fixedVulnerabilities(repoDir);
  previouslyFixed.close();
  const report = await scanRepo(repoDir, {
    ...(only ? { only } : {}),
    includeDev: args.flags.get('no-dev') !== true,
    ...(contracts ? { contracts } : {}),
    ...(vulnerabilities ? { vulnerabilities } : {}),
    ...(lintFrom(args) ? { lint: lintFrom(args)! } : {}),
    freshness: args.flags.get('freshness') === true,
    onProgress: args.flags.get('json') === true ? () => {} : (m) => console.log(c.dim(`  ${m}`)),
  });

  // Checked against what is installed now, not against the findings: a package
  // can slip back below the version that fixed it without any advisory being
  // rediscovered, and that is exactly the case worth catching.
  if (fixedBefore.length > 0) {
    const installed = new Map(
      (await readRepo(repoDir)).dependencies
        .filter((d) => d.installed !== null)
        .map((d) => [d.name, d.installed as string]),
    );
    for (const back of reintroduced(fixedBefore, installed)) {
      report.warnings.push(
        `${back.pkg} was fixed at ${back.was} and now resolves to ${back.now} — a vulnerability this repository already dealt with has come back (${back.advisories.join(', ')})`,
      );
    }
  }

  if (args.flags.get('json') === true) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printScan(report, args.flags.get('all') === true, await publishedVersions(report, contracts));
  }

  const store = new Store();
  const delta = store.recordScan(report, repo.name);
  store.close();

  if (args.flags.get('json') !== true) {
    // What a scheduled run is for. The full list is the same every time and gets
    // skipped; the change since last time is the part worth a notification.
    if (delta.first) {
      console.log(c.dim(`  First scan of this repository — this is the baseline, not a change list.`));
    } else if (delta.added.length + delta.returned.length + delta.resolved.length === 0) {
      console.log(c.dim(`  Nothing changed since the last scan.`));
    } else {
      const parts: string[] = [];
      if (delta.added.length > 0) parts.push(c.red(`${delta.added.length} new`));
      // Named separately because "it came back" and "it is new" call for
      // different responses, and the first is usually a revert to look at.
      if (delta.returned.length > 0) parts.push(c.yellow(`${delta.returned.length} returned`));
      if (delta.resolved.length > 0) parts.push(c.green(`${delta.resolved.length} resolved`));
      console.log(`  Since the last scan: ${parts.join(c.dim(', '))}`);
    }
    console.log(c.dim(`  Stored. Run ${c.bold('emend serve')} to browse, or ${c.bold('emend fix <repo>')} to migrate.`));
    console.log('');
  }
  return report.counts.breaking > 0 ? 1 : 0;
}

/**
 * Parameters the vendor added to endpoints this repository already calls.
 *
 * Reported and never repaired, which is the whole point of separating them. A
 * new filter is a capability, and writing one into a call changes which rows
 * come back — the Resend regression in reverse, identical response shape and a
 * different result set. Emend does not make that choice for anybody, the same
 * way `plan.ts` declines to pick a replacement route.
 *
 * A pagination control is called out differently because it is not a capability
 * at all. Its appearance says the endpoint pages, so a caller that never pages
 * has been taking the default and treating it as the whole answer.
 */
function reportOfferedParameters(findings: Finding[]): void {
  if (findings.length === 0) return;

  const paging = findings.filter((f) => offersPagination(f.change.path));
  const capabilities = findings.filter((f) => !offersPagination(f.change.path));

  console.log(c.bold('  newly offered by the vendor') + c.dim(`  (${findings.length})`));

  if (paging.length > 0) {
    console.log(
      c.yellow('    These endpoints page, and these calls do not — check what you are missing:'),
    );
    for (const f of paging) {
      console.log(`      ${c.cyan(f.pkg)}  ${f.change.path}`);
      for (const site of f.sites.slice(0, 2)) {
        console.log(c.dim(`        → ${site.file}:${site.line}`));
      }
    }
  }

  if (capabilities.length > 0) {
    console.log(c.dim('    Available and unused. Adopting one changes which records come back,'));
    console.log(c.dim('    so it is a decision rather than a repair and Emend will not make it:'));
    for (const f of capabilities) {
      console.log(c.dim(`      ${f.pkg}  ${f.change.path}`));
    }
  }
  console.log('');
}

/**
 * Report wire-contract findings, and hand them to a session if asked.
 *
 * Its own function because it shares nothing with the package path but the
 * repository. A wire API has no version to bump, so there is no deterministic
 * repair to offer at all: the replacement route is the vendor's to publish, and
 * picking one would be the guess `plan.ts` refuses to make everywhere else. What
 * Emend contributes is the located call sites and, afterwards, the judgement of
 * whether the edit changed anything it should not have.
 */
async function fixWireContracts(repoDir: string, findings: Finding[], args: Args): Promise<void> {
  if (findings.length === 0) return;

  // Split before anything else, because the two halves want opposite things. A
  // route the description no longer contains is a repair; a parameter it newly
  // offers is not, and handing one to `driveContractPrompt` would tell a session
  // that a working call was removed.
  const repairs = findings.filter((f) => f.change.severity !== 'feature');
  const offered = findings.filter((f) => f.change.severity === 'feature');

  if (repairs.length > 0) {
    console.log(c.bold('  wire contracts') + c.dim(`  (${repairs.length} finding(s))`));
    for (const f of repairs) {
      console.log(`    ${c.cyan(f.pkg)}  ${f.change.path}`);
      for (const site of f.sites.slice(0, 3)) {
        console.log(c.dim(`      → ${site.file}:${site.line}  ${site.text.trim().slice(0, 80)}`));
      }
      if (f.change.guidance) console.log(c.dim(`      ${f.change.guidance}`));
    }
  }

  reportOfferedParameters(offered);
  if (repairs.length === 0) return;

  const model = args.flags.get('drive');
  if (!model) {
    console.log(
      c.dim('    No mechanical repair: a wire API has no version to bump and the replacement route'),
    );
    console.log(c.dim('    is the vendor’s to publish. Use --drive to hand these to an agent.'));
    console.log('');
    return;
  }

  const permitted = harnessPermitted({ untrusted: args.flags.get('untrusted') === true });
  if (!permitted.ok) {
    console.log(c.yellow(`    declining to drive: ${permitted.reason}`));
    console.log('');
    return;
  }

  const harness = drivingHarness({
    ...(typeof model === 'string' ? { model } : {}),
    emendCommand: [
      process.execPath,
      '--experimental-strip-types',
      fileURLToPath(import.meta.url),
      'mcp',
    ],
  });
  const availability = await harness.available();
  if (!availability.ok) {
    console.log(c.yellow(`    cannot drive: ${availability.reason}`));
    console.log('');
    return;
  }

  for (const f of repairs) {
    console.log(c.dim(`    driving ${harness.id} for ${f.change.path}`));
    const run = await harness.run(repoDir, {
      // The wire-contract instruction, not the vulnerability one. The difference
      // is not cosmetic: told it was fixing a vulnerability, a session went
      // looking for a GitHub advisory until it timed out.
      instruction: driveContractPrompt({
        repo: repoDir,
        findingId: f.id,
        host: f.pkg,
        route: f.change.path,
        sites: f.sites.map((site) => ({ file: site.file, line: site.line })),
        description: f.change.guidance ?? f.toVersion,
      }),
      failureOutput: '',
    });

    const said = assistantText(run.log).trim();
    const summary = (run.summary ?? '').trim();
    if (summary) console.log(c.dim(`    ${summary.slice(0, 2000)}`));
    if (said) console.log(said.slice(0, 4000).split('\n').map((l) => `    ${l}`).join('\n'));
    if (!run.ok) console.log(c.red(`    ${run.error ?? 'the session failed'}`));
    if (run.ok && !said && !summary) console.log(c.yellow('    the session produced no output'));

    const changed = (
      await execFileAsync('git', ['diff'], { cwd: repoDir, maxBuffer: 32 * 1024 * 1024 })
    ).stdout;
    if (changed.trim() === '') continue;

    await reviewBehaviour(repoDir, f, changed, typeof model === 'string' ? model : undefined);
  }
  console.log('');
}

/**
 * A second session, which never saw the first one's reasoning.
 *
 * Measured twice: a driven fix picked a plausible route, justified it, compiled,
 * and changed what came back — a different page size on one repository, a lost
 * audience filter on another. Neither is visible to a build, because a URL is a
 * string that compiles whatever it says, and neither was caught by the session
 * that argued itself into it.
 */
async function reviewBehaviour(
  repoDir: string,
  finding: Finding,
  diff: string,
  model: string | undefined,
): Promise<void> {
  const review = await reviewSession<ContractFinding>({
    harness: openCodeHarness({
      readOnly: true,
      allowBash: true,
      // Its own budget, not the ten minutes the repair already spent. Measured:
      // the review started after a drive that had used most of the default and
      // produced nothing but a step_start, so the run could only report that
      // behaviour went unreviewed. The question it answers — does this still
      // return the same rows — is not a cheaper job than the edit was.
      timeoutMs: 20 * 60 * 1000,
      ...(model ? { model } : {}),
    }),
    dir: repoDir,
    pkg: finding.pkg,
    fromVersion: finding.fromVersion,
    toVersion: finding.toVersion,
    diff,
    // The parser travels with the prompt. Asking for `kind`/`path`/`detail` and
    // reading for `severity`/`file`/`what`/`why` meant a review that named the
    // exact regression it exists to catch was reported as having found nothing.
    parse: parseContractFindings,
    prompt: contractReviewPrompt({
      host: finding.pkg,
      route: finding.change.path,
      description: finding.change.guidance ?? finding.toVersion,
      diff,
    }),
    progress: (m) => console.log(c.dim(`    ${m}`)),
  });

  if (!review.ok) {
    // Could not review is not reviewed and clean, and this is the one place that
    // distinction decides whether an edit ships.
    console.log(c.yellow(`    behaviour unreviewed: ${review.reason ?? 'unknown'}`));
  } else if (review.findings.length === 0) {
    console.log(c.green('    behaviour review found no change beyond the route'));
  } else {
    console.log(c.red(`    behaviour review: ${review.findings.length} concern(s)`));
    console.log(renderContractFindings(review.findings));
  }
}

/**
 * Lint findings, all in one workspace.
 *
 * One rather than one each: the repairs are independent text edits in separate
 * files, and a single verification answers for the lot. That is the opposite of
 * the vulnerability path, where each fix is its own dependency change and
 * bundling them would let one failure withhold every other.
 */
async function runLintFixes(repoDir: string, findings: Finding[], args: Args): Promise<boolean> {
  if (findings.length === 0) return false;

  console.log(c.bold('  lint') + c.dim(`  (${findings.length} finding(s))`));
  const result = await fixLint(repoDir, findings, {
    keepWorkspace: args.flags.get('keep') === true,
    useAgent: agentAllowed(args),
    onProgress: (m) => console.log(c.dim(`    ${m}`)),
  });

  const ok = result.verification !== null && verificationPassed(result.verification.outcome);
  if (result.repaired.length > 0 || result.agentEdits > 0) {
    const what = [
      result.repaired.length > 0 ? `${result.repaired.length} file(s) by shellcheck` : '',
      result.agentEdits > 0 ? `${result.agentEdits} edit(s) by the model` : '',
    ]
      .filter(Boolean)
      .join(', ');
    console.log(`    ${ok ? c.green('VERIFIED') : c.red('NOT VERIFIED')}  ${c.dim(what)}`);
  }
  // Never silent about the half nothing can repair.
  if (result.unrepairable.length > 0) {
    console.log(
      c.yellow(
        `    ${result.unrepairable.length} finding(s) still unrepaired${agentAllowed(args) ? '' : ' — this run was --no-agent, so the model never tried'}:`,
      ),
    );
    for (const u of result.unrepairable.slice(0, 5)) {
      console.log(c.dim(`      ${u.finding.change.path} — ${u.reason}`));
    }
  }
  if (result.caveat) console.log(c.yellow(`    ${result.caveat}`));
  if (result.workspaceDir) console.log(c.dim(`    workspace kept at ${result.workspaceDir}`));
  return ok;
}

/**
 * Packages behind their latest version where nothing this repository calls
 * changed. A plain bump, verified — there is no migration to plan.
 */
async function runFreshnessFixes(repoDir: string, findings: Finding[], args: Args): Promise<boolean> {
  let verified = false;
  for (const finding of findings) {
    console.log(
      c.bold(`  ${finding.pkg} ${finding.fromVersion} → ${finding.toVersion}`) +
        c.dim('  (behind latest)'),
    );
    const result = await fixFreshness(repoDir, finding, {
      keepWorkspace: args.flags.get('keep') === true,
      onProgress: (m) => console.log(c.dim(`    ${m}`)),
    });
    const ok = result.verification !== null && verificationPassed(result.verification.outcome);
    if (ok) verified = true;
    console.log(
      `    ${ok ? c.green('VERIFIED') : c.red('NOT VERIFIED')}  ${c.dim(result.verification?.summary ?? '')}`,
    );
    if (result.workspaceDir) console.log(c.dim(`    workspace kept at ${result.workspaceDir}`));
  }
  return verified;
}

/**
 * Version literals that disagree with something able to arbitrate them.
 *
 * Deterministic throughout: the target version is known, the location is known,
 * and the change is a substring substitution. No model is offered one here
 * because none is needed.
 */
async function runPinFixes(repoDir: string, findings: Finding[], args: Args): Promise<boolean> {
  if (findings.length === 0) return false;

  console.log(c.bold(`  version pins`) + c.dim(`  (${findings.length} drifted)`));
  const result = await fixPins(repoDir, {
    keepWorkspace: args.flags.get('keep') === true,
    onProgress: (m) => console.log(c.dim(`    ${m}`)),
  });
  const ok = verificationPassed(result.verification.outcome);
  console.log(
    `    ${ok ? c.green('VERIFIED') : c.red(result.verification.outcome.toUpperCase())}` +
      `  ${result.appliedEdits} pin edit(s)`,
  );
  console.log('');
  return ok && result.appliedEdits > 0;
}

/**
 * What every branch of `cmdFix` needs and none of them owns.
 *
 * `store` because a fix that landed has to be recorded, and `reviewHarness`
 * because it is resolved once from the flags — building one per package would
 * be the same object made repeatedly, and would make the reviewer look like a
 * per-package decision rather than a run-wide one.
 */
interface FixContext {
  store: Store;
  reviewHarness: Harness | undefined;
}

/**
 * Known vulnerabilities, each in its own workspace.
 *
 * Getting one package out of the tree is a self-contained change, and bundling
 * them would make a single failure withhold every other fix.
 */
async function runVulnerabilityFixes(
  repoDir: string,
  findings: Finding[],
  args: Args,
  ctx: FixContext,
): Promise<boolean> {
  let verified = false;

  for (const finding of findings) {
    console.log(
      c.bold(`  ${finding.pkg} ${finding.fromVersion} → ${finding.toVersion}`) +
        c.dim('  (vulnerability)'),
    );

    // `--drive` hands the whole loop to an opencode session pointed at Emend's
    // own MCP server. Emend keeps the deterministic half as tools it cannot
    // fake; the session does the repairing, which it can do because it has edit
    // rights and a loop of its own.
    if (args.flags.get('drive')) {
      await driveOneFinding(repoDir, finding, args);
      continue;
    }

    const result = await fixVulnerability(repoDir, finding, {
      keepWorkspace: args.flags.get('keep') === true,
      // Without this the repair loop is unreachable and a security bump that
      // breaks the build is reported as unfixable by the one tool here that
      // knows how to fix it.
      useAgent: agentAllowed(args),
      ...(ctx.reviewHarness ? { reviewHarness: ctx.reviewHarness } : {}),
      onProgress: (m) => console.log(c.dim(`    ${m}`)),
    });

    // Why this package is in the tree at all — the first thing a reviewer asks
    // of a transitive advisory, and the reason bumping `express` for a CVE in
    // `qs` is an instruction rather than a non sequitur.
    if (result.remediation.kind === 'parent') {
      for (const route of result.remediation.paths) {
        console.log(c.dim(`    via  ${route.join(' → ')}`));
      }
    }
    // The repo-wide review's findings. Advisory output for a human, so the human
    // has to see it.
    for (const f of result.reviewNotes ?? []) {
      console.log(`    ${c.yellow(`[${f.severity}]`)} ${f.file}  ${c.dim(f.what)}`);
      console.log(c.dim(`        ${f.why}`));
    }
    // A repaired fix and a fix that never needed repair are not the same result,
    // and a reviewer reading the diff is entitled to know which one this is.
    if (result.agent) {
      const { attempts, finalErrors, initialErrors } = result.agent;
      console.log(
        c.dim(
          `    repaired the breaking upgrade in ${attempts.length} attempt(s), ` +
            `${initialErrors} → ${finalErrors} error(s)`,
        ),
      );
    }

    // Two conditions, and both must hold. A green build with the vulnerable
    // version still installed is the failure most easily mistaken for success.
    const passed = result.verification !== null && verificationPassed(result.verification.outcome);
    const fixed = passed && result.resolved;
    if (fixed) {
      verified = true;
      // Only on a verified fix. Recording an attempt would make the regression
      // guard fire on a package that was never actually repaired.
      ctx.store.recordVulnerabilityFixed(
        repoDir,
        finding.pkg,
        result.installedAfter ?? finding.toVersion,
        [finding.change.path],
      );
    }
    console.log(
      `    ${
        fixed
          ? c.green('FIXED')
          : result.remediation.kind === 'none'
            ? c.yellow('NO FIX AVAILABLE')
            : c.red('NOT FIXED')
      }  ${c.dim(result.verification?.summary ?? result.note ?? '')}`,
    );
    // Never silent. An override forces a version a dependency did not ask for,
    // and a reviewer has to know a constraint was overridden rather than met.
    if (result.overrode) {
      console.log(
        c.yellow(
          `    forced via an overrides entry — no dependency's own range selects ${finding.toVersion}`,
        ),
      );
    }
    if (result.note && !fixed) console.log(c.yellow(`    ${result.note}`));
    if (result.workspaceDir) console.log(c.dim(`    workspace kept at ${result.workspaceDir}`));
  }

  return verified;
}

/**
 * Hand one finding to a session that owns the workspace.
 *
 * There is no gate on this path — the session edits directly — so the log is
 * the whole account of what happened, and hiding any of it would be the wrong
 * trade. `false` means the session did not complete, which the package path
 * treats as fatal and the vulnerability path does not.
 */
async function driveOneFinding(repoDir: string, finding: Finding, args: Args): Promise<boolean> {
  const permitted = harnessPermitted({ untrusted: args.flags.get('untrusted') === true });
  if (!permitted.ok) {
    console.log(c.yellow(`    declining to drive: ${permitted.reason}`));
    return false;
  }
  const model = args.flags.get('drive');
  const harness = drivingHarness({
    ...(typeof model === 'string' ? { model } : {}),
    emendCommand: [
      process.execPath,
      '--experimental-strip-types',
      fileURLToPath(import.meta.url),
      'mcp',
    ],
  });
  const availability = await harness.available();
  if (!availability.ok) {
    console.log(c.yellow(`    cannot drive: ${availability.reason}`));
    return false;
  }

  console.log(c.dim(`    driving ${harness.id} against emend's own tools`));
  const run = await harness.run(repoDir, {
    instruction: drivePrompt({ repo: repoDir, findingId: finding.id, pkg: finding.pkg }),
    failureOutput: '',
  });
  const said = assistantText(run.log).trim();
  const summary = (run.summary ?? '').trim();
  if (summary) console.log(c.dim(`    ${summary.slice(0, 2000)}`));
  if (said) console.log(said.slice(0, 4000).split('\n').map((l) => `    ${l}`).join('\n'));
  if (!run.ok) console.log(c.red(`    ${run.error ?? 'the session failed'}`));
  if (run.ok && !said && !summary) console.log(c.yellow('    the session produced no output'));
  return run.ok;
}

/**
 * Dependency upgrades, one workspace per package.
 *
 * A version bump is atomic, so every finding for one package is fixed together
 * and lands as one pull request.
 *
 * `exit` is not decoration. Under `--drive` this path stops the whole command
 * after the first package rather than moving to the next, which is what the
 * inline version did and is deliberately preserved here — the vulnerability
 * path continues instead, and the two really do differ. Returning the code
 * makes that visible; before, it was a `return` buried inside two loops.
 */
async function runPackageFixes(
  repoDir: string,
  byPackage: Map<string, Finding[]>,
  args: Args,
  ctx: FixContext,
): Promise<{ verified: boolean; exit: number | null }> {
  let verified = false;

  for (const [pkg, findings] of byPackage) {
    const first = findings[0];
    if (!first) continue;

    console.log(
      c.bold(`  ${pkg} ${first.fromVersion} → ${first.toVersion}`) +
        c.dim(`  (${findings.length} finding${findings.length === 1 ? '' : 's'})`),
    );
    for (const f of findings) {
      console.log(c.dim(`    · ${f.change.path} (${f.change.kind}, ${f.id})`));
    }

    // Deleting runAgentRepair left drift with no repair mechanism at all —
    // `--agent` became a no-op here — and drift is the thesis, so it needed a
    // driven session more than vulnerabilities did.
    if (args.flags.get('drive')) {
      return { verified, exit: (await driveOneFinding(repoDir, first, args)) ? 0 : 1 };
    }

    const harness = harnessFrom(args);
    const result = await fixPackage(repoDir, findings, {
      keepWorkspace: args.flags.get('keep') === true,
      useAgent: agentAllowed(args),
      ...(harness ? { harness } : {}),
      ...(ctx.reviewHarness ? { reviewHarness: ctx.reviewHarness } : {}),
      onProgress: (m) => console.log(c.dim(`    ${m}`)),
    });

    const v = result.verification;
    const badge =
      v.outcome === 'verified'
        ? c.green('VERIFIED')
        : v.outcome === 'typecheck-only'
          ? c.yellow('TYPECHECK ONLY')
          : v.outcome === 'regression'
            ? c.red('INCOMPLETE — not safe to merge')
            : v.outcome === 'pre-existing-failure'
              ? c.yellow('INCONCLUSIVE (repo was already failing)')
              : c.yellow('UNVERIFIED');
    const source = result.agent
      ? c.magenta(`deterministic + agent(${result.agent.model})`)
      : c.dim('deterministic');
    console.log(`    ${badge}  ${source}  ${c.dim(`${result.appliedEdits} edit(s)`)}`);
    console.log(`    ${c.dim(v.summary)}`);

    if (result.unplanned.length > 0 && !result.agent) {
      console.log(
        c.yellow(
          `    ${result.unplanned.length} finding(s) had no deterministic fix${agentAllowed(args) ? ' and the model did not land one' : ' — this run was --no-agent'}:`,
        ),
      );
      for (const f of result.unplanned) console.log(c.dim(`      · ${f.change.path}`));
    }
    if (result.agent) {
      for (const a of result.agent.attempts) {
        console.log(
          c.dim(`      attempt ${a.attempt}: ${a.outcome}${a.error ? ` — ${a.error.slice(0, 120)}` : ''}`),
        );
      }
      if (result.agent.rationale) {
        console.log(c.dim(`      rationale: ${result.agent.rationale.slice(0, 200)}`));
      }
    }
    if (result.harness) {
      const h = result.harness;
      // An escalation that ran and achieved nothing has to be as visible as one
      // that worked. It is the most expensive step in the pipeline, and a run
      // that quietly declined to happen looks identical to one that tried.
      console.log(
        h.ok
          ? c.magenta(
              `      harness ${h.id}: ${h.keptHunks} hunk(s) kept, ${h.revertedHunks.length} reverted`,
            )
          : c.yellow(`      harness ${h.id}: ${h.reason}`),
      );
      for (const r of h.revertedHunks) {
        console.log(c.dim(`        reverted ${r.hunk.file}:${r.hunk.start} — ${r.reason}`));
      }
    }
    if (result.workspaceDir) console.log(`    ${c.dim(`workspace kept at ${result.workspaceDir}`)}`);
    if (verificationPassed(v.outcome)) verified = true;

    if (result.diff) {
      console.log('');
      for (const line of result.diff.split('\n').slice(0, 60)) {
        if (line.startsWith('+') && !line.startsWith('+++')) console.log(`      ${c.green(line)}`);
        else if (line.startsWith('-') && !line.startsWith('---')) console.log(`      ${c.red(line)}`);
        else console.log(`      ${c.dim(line)}`);
      }
    }

    const rationale =
      result.plans.map((p) => p.rationale).join(' ') || result.agent?.rationale || null;
    const agent = result.agent
      ? { model: result.agent.model, provider: result.agent.provider }
      : null;
    for (const f of findings) {
      ctx.store.recordRun(f.id, repoDir, v, rationale, result.diff, agent);
    }
    console.log('');
  }

  return { verified, exit: null };
}

async function cmdFix(args: Args): Promise<number> {
  const repoDir = path.resolve(args.positional[0] ?? '.');
  const store = new Store();
  const findingId = args.flags.get('finding');

  let targets: Finding[];
  const stored = store.listFindings(repoDir).filter((f) => f.status === 'open');
  if (typeof findingId === 'string') {
    const found = stored.find((f) => f.findingId === findingId);
    if (!found) {
      console.error(c.red(`  No open finding ${findingId} for ${repoDir}. Run 'emend scan' first.`));
      store.close();
      return 1;
    }
    targets = [found.finding];
  } else {
    targets = stored.map((f) => f.finding);
    if (targets.length === 0) {
      console.error(c.yellow(`  No stored findings for ${repoDir}. Run 'emend scan ${repoDir}' first.`));
      store.close();
      return 1;
    }
  }

  // Route by detector, which is what the field is for. A version-pin finding
  // names its subject in `pkg` — `node`, `playwright` — and handing that to the
  // package path would run `npm install node@22`, which is nonsense and would
  // half-succeed in ways that are hard to unpick.
  const pinTargets = targets.filter((f) => f.detector === 'version-pin');
  const vulnTargets = targets.filter((f) => f.detector === 'vulnerability');
  const lintTargets = targets.filter((f) => f.detector === 'external-lint');
  const freshTargets = targets.filter((f) => f.detector === 'freshness');
  // A wire-contract finding names a host in `pkg`, not a package, and has no
  // version to bump — the same reason version pins are routed away from here.
  const contractTargets = targets.filter(needsSourceRepair);
  const packageTargets = targets.filter(
    (f) =>
      f.detector !== 'version-pin' &&
      f.detector !== 'vulnerability' &&
      f.detector !== 'external-lint' &&
      f.detector !== 'freshness' &&
      !needsSourceRepair(f),
  );

  // Group by package: a version bump is atomic, so every finding for one
  // package must be fixed together in one workspace and land as one PR.
  const byPackage = new Map<string, Finding[]>();
  for (const f of packageTargets) {
    const list = byPackage.get(f.pkg) ?? [];
    list.push(f);
    byPackage.set(f.pkg, list);
  }

  console.log('');
  const ctx: FixContext = { store, reviewHarness: reviewHarnessFrom(args) };

  // Collected rather than folded into a running flag. `anyVerified ||= await …`
  // reads better and is wrong: once one branch has verified, `||=` stops
  // evaluating its right-hand side, so every later branch would be skipped for
  // the sole reason that an earlier one succeeded.
  const verified: boolean[] = [];
  verified.push(await runVulnerabilityFixes(repoDir, vulnTargets, args, ctx));
  verified.push(await runLintFixes(repoDir, lintTargets, args));
  verified.push(await runFreshnessFixes(repoDir, freshTargets, args));
  await fixWireContracts(repoDir, contractTargets, args);
  verified.push(await runPinFixes(repoDir, pinTargets, args));

  const packages = await runPackageFixes(repoDir, byPackage, args, ctx);
  // A driven run reports its own exit and stops the command — one package, then
  // done. Preserved from the inline version rather than reconciled with the
  // vulnerability path, which continues; changing that is a behaviour decision,
  // not a refactor.
  if (packages.exit !== null) {
    store.close();
    return packages.exit;
  }
  verified.push(packages.verified);

  store.close();
  console.log(c.dim(`  Run ${c.bold('emend pr <repo> --finding <id>')} to preview a pull request.`));
  console.log('');
  return verified.some(Boolean) ? 0 : 1;
}

async function cmdPr(args: Args): Promise<number> {
  const repoDir = path.resolve(args.positional[0] ?? '.');
  const findingId = args.flags.get('finding');
  if (typeof findingId !== 'string') {
    console.error(c.red('  --finding <id> is required. Get an id from `emend scan`.'));
    return 1;
  }

  const store = new Store();
  const stored = store.getFinding(findingId, repoDir);
  if (!stored) {
    console.error(c.red(`  No finding ${findingId} for ${repoDir}.`));
    store.close();
    return 1;
  }

  const creating = args.flags.get('create') === true;

  console.log(c.dim('  re-running fix to produce a verified PR body...'));
  const prHarness = harnessFrom(args);
  const result = await fixFinding(repoDir, stored.finding, {
    // Without this, `emend pr --agent` silently re-ran deterministic-only and
    // rendered "unverified / needs a human" for a migration that had just
    // verified under `emend fix --agent`.
    useAgent: agentAllowed(args),
    // Same reason: a PR re-run without the harness renders "needs a human" for a
    // migration that had just verified under `emend fix --harness`.
    ...(prHarness ? { harness: prHarness } : {}),
    // The verified edits live in the isolated workspace, never in the checkout.
    // Opening a PR from the checkout commits nothing, so the workspace has to
    // survive long enough to push from.
    keepWorkspace: creating,
    onProgress: (m) => console.log(c.dim(`    ${m}`)),
  });
  store.close();

  const title = renderPrTitle(result);
  // The reading guide, when a model is reachable. Rendered from the same
  // evidence the body already carries, and skipped in silence when it is not —
  // `renderPrBody` stays pure and simply has one section fewer.
  const briefing = asker({ disabled: !agentAllowed(args) });
  const summary = briefing.ok ? await summarisePr(briefing.asker, result) : null;
  const body = renderPrBody(result, { ...(summary ? { summary } : {}) });

  if (!creating) {
    console.log('');
    console.log(c.bold(`  TITLE  ${title}`));
    console.log('');
    console.log(body);
    console.log('');
    console.log(
      c.yellow(
        '  This was a dry run. Nothing was pushed and no PR was opened.\n' +
          '  Re-run with --create to open a draft PR (requires a GitHub remote and `gh` auth).',
      ),
    );
    console.log('');
    return 0;
  }

  if (!result.verification || !verificationPassed(result.verification.outcome)) {
    console.error(
      c.red(
        `  Refusing to open a PR: verification came back "${result.verification?.outcome ?? 'none'}".\n` +
          '  Only a verified or typecheck-only migration is proposable. A failing\n' +
          '  baseline usually means the checkout\'s dependencies do not match its\n' +
          '  manifests — reinstall, confirm the repository is green, then re-run.',
      ),
    );
    return 1;
  }

  if (result.workspaceMode !== 'worktree' || !result.workspaceDir) {
    console.error(
      c.red(
        '  Refusing to open a PR: the workspace is not a git worktree, so it has\n' +
          '  no remote to push to. This happens when the repository has no commits.',
      ),
    );
    return 1;
  }

  const branch = `emend/${branchSlug(stored.finding.pkg)}-${stored.finding.id}`;
  const res = await createPullRequest({
    repoDir: result.workspaceDir,
    branch,
    title,
    body,
    draft: true,
  });
  await rm(result.workspaceDir, { recursive: true, force: true }).catch(() => {});
  if (!res.ok) {
    console.error(c.red(`  PR creation failed: ${res.error}`));
    return 1;
  }
  console.log(c.green(`  Draft PR opened: ${res.url}`));
  return 0;
}

async function cmdModels(args: Args): Promise<number> {
  const providerFlag = args.flags.get('provider');
  // The provider this listing is *for*, worked out once. Deriving it a second
  // time to find the default let a `--provider` that has none fall through to
  // the environment's provider, and print that one's default against a
  // different provider's catalogue.
  const providerId =
    typeof providerFlag === 'string' ? providerFlag : (process.env.EMEND_LLM_PROVIDER ?? '');
  const resolved = resolveLlmConfig({
    ...(providerId ? { provider: providerId } : {}),
    // `models` only needs an endpoint, not a model choice.
    model: 'placeholder',
  });

  if (!resolved.ok) {
    console.error('');
    console.error(c.red(`  ${resolved.reason}`));
    console.error('');
    console.error(c.bold('  Available provider presets:'));
    for (const p of Object.values(PROVIDERS)) {
      console.error(`    ${c.cyan(p.id.padEnd(11))} ${p.label}`);
      console.error(c.dim(`                ${p.baseUrl}`));
      console.error(c.dim(`                key: ${p.keyEnv.join(' or ')}  ·  ${p.docs}`));
    }
    console.error('');
    console.error(c.dim('  Example:'));
    console.error(c.dim('    export EMEND_LLM_PROVIDER=nebius'));
    console.error(c.dim('    export NEBIUS_API_KEY=...'));
    console.error(c.dim('    emend models'));
    console.error('');
    return 1;
  }

  console.log(c.dim(`  querying ${resolved.config.providerLabel} (${resolved.config.baseUrl})`));
  const res = await listModels(resolved.config);
  if (!res.ok) {
    console.error(c.red(`  could not list models: ${res.error}`));
    return 1;
  }

  const fallback = PROVIDERS[providerId]?.defaultModel;

  console.log('');
  for (const m of res.models) {
    // Mark the default in the listing itself. A catalogue of several hundred
    // models with no recommendation is how the previous stale pick happened.
    console.log(m === fallback ? `  ${c.cyan(m)} ${c.dim('← default')}` : `  ${m}`);
  }
  console.log('');
  console.log(
    c.dim(
      `  ${res.models.length} model(s). ` +
        (fallback
          ? `Defaults to ${fallback}; override with EMEND_LLM_MODEL.`
          : 'Set one with EMEND_LLM_MODEL.') +
        ` Then run 'emend fix <repo> --agent'.`,
    ),
  );
  console.log('');
  return 0;
}

async function cmdServe(args: Args): Promise<number> {
  const port = Number(args.flags.get('port') ?? 4000);
  await startServer(port);
  return 0;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Bring drifted version pins back in line.
 *
 * Separate from `fix` because the unit of work is different: a pin conflict
 * belongs to the repository rather than to any package upgrade, and needs no
 * stored finding to act on — the lockfile and the files that copied out of it
 * are all the evidence there is.
 */
async function cmdPins(args: Args): Promise<number> {
  const repoDir = path.resolve(args.positional[0] ?? '.');
  const result = await fixPins(repoDir, {
    keepWorkspace: args.flags.get('keep') === true,
    onProgress: (m) => console.log(c.dim(`  ${m}`)),
  });

  console.log('');
  if (result.conflicts.length === 0) {
    console.log(c.green('  Every version pin agrees with what the repository installs.'));
    console.log('');
    return 0;
  }

  for (const conflict of result.conflicts) {
    console.log(
      conflict.expected
        ? `  ${c.yellow('drift')}      ${conflict.subject} → ${conflict.expected} (${conflict.authority})`
        : `  ${c.yellow('conflict')}   ${conflict.subject} — nothing declares the intended version, so this one needs a human`,
    );
    for (const pin of conflict.pins) {
      console.log(c.dim(`    → ${pin.file}:${pin.line}  ${pin.text}`));
    }
  }

  const v = result.verification;
  console.log('');

  // A repair that changed nothing is not a success, however green the build is.
  // Verification only ever says "this change broke nothing", and an empty change
  // breaks nothing by construction — so reporting VERIFIED here would be a badge
  // for having done no work.
  if (result.repairable > 0 && result.appliedEdits === 0) {
    console.log(`  ${c.red('NOT REPAIRED')}  ${result.repairable} conflict(s) could be fixed and none were`);
    for (const failure of result.failedEdits) {
      console.log(c.dim(`    ${failure.file}: ${failure.reason}`));
    }
    if (result.failedEdits.some((f) => /cannot read/i.test(f.reason))) {
      console.log('');
      console.log(
        c.dim('    Emend migrates inside a git worktree, which contains committed files only.'),
      );
      console.log(c.dim('    Commit these files first, then run again.'));
    }
    console.log('');
    return 1;
  }

  console.log(
    `  ${verificationPassed(v.outcome) ? c.green(v.outcome.toUpperCase()) : c.red(v.outcome.toUpperCase())}` +
      `  ${result.appliedEdits} edit(s) applied of ${result.repairable} repairable conflict(s)`,
  );
  console.log(c.dim(`  ${v.summary}`));
  for (const failure of result.failedEdits) {
    console.log(c.yellow(`  not applied — ${failure.file}: ${failure.reason}`));
  }
  if (result.diff) {
    console.log('');
    console.log(result.diff.split('\n').map((l) => `    ${l}`).join('\n'));
  }
  console.log('');
  return verificationPassed(v.outcome) ? 0 : 1;
}

/**
 * Measure the agent against a corpus, so changing it is a decision.
 *
 * Each case costs a full install, migration and verification, so the corpus is
 * named explicitly rather than discovered: a sweep should be something you chose
 * to pay for. `--model` may be repeated to compare, which is the point.
 */
async function cmdEval(args: Args): Promise<number> {
  const casesFlag = args.flags.get('cases');
  const cases = await loadCases(typeof casesFlag === 'string' ? casesFlag : undefined);
  if (cases.length === 0) {
    console.error(c.red('  no cases — pass --cases <file.json>'));
    return 1;
  }
  const modelFlag = args.flags.get('model');
  const models = typeof modelFlag === 'string' ? modelFlag.split(',') : [''];
  // Two runs of the same recharts migration under the same model gave opposite
  // results — one removed `Cell` and rendered `$NaN`, the other narrowed
  // correctly and left `Cell` behind. One run is an anecdote, so repeating is
  // how the difference between a change and noise becomes visible.
  const repeatFlag = args.flags.get('repeat');
  const repeat = typeof repeatFlag === 'string' ? Math.max(1, Number(repeatFlag) || 1) : 1;

  console.log('');
  console.log(
    c.bold(
      `  Emend eval — ${cases.length} case(s) x ${models.length} model(s)` +
        (repeat > 1 ? ` x ${repeat} run(s)` : ''),
    ),
  );
  console.log('');

  // Resolved once for the sweep, so every run is the same engine and the table
  // can attribute results to it. §8's condition on adopting a harness is exactly
  // this: it swaps the editing engine, so it has to be measured as one.
  const evalHarness = harnessFrom(args);
  const outcomes: CaseOutcome[] = [];
  for (const model of models) {
    for (const evalCase of cases) {
      for (let run = 1; run <= repeat; run++) {
        const label = model || 'deterministic';
        process.stdout.write(
          `  ${label} · ${evalCase.id}${repeat > 1 ? ` · run ${run}/${repeat}` : ''} … `,
        );
        // Materialised per run, never reused: a second run starting from the
        // first one's migrated files would measure something else entirely.
        const dir = await materialiseCase(evalCase);
        try {
          if (model) process.env['EMEND_LLM_MODEL'] = model;
          const outcome = await runCase(evalCase, dir, label, {
            useAgent: Boolean(model),
            ...(evalHarness ? { harness: evalHarness } : {}),
          });
          outcomes.push(outcome);
          const score = scoreCase(evalCase, outcome);
          console.log(
            score.clean
              ? c.green('clean')
              : score.passed
                ? c.yellow(`passed — ${score.penalties[0] ?? ''}`)
                : c.red(outcome.verdict),
          );
        } finally {
          if (evalCase.repo.kind !== 'local') {
            await rm(dir, { recursive: true, force: true }).catch(() => {});
          }
        }
      }
    }
  }

  console.log('');
  console.log(renderSummary(summarise(cases, outcomes)));
  console.log('');
  // Never a non-zero exit for a bad score: this reports, it does not police, and
  // a sweep that "fails" is indistinguishable from one that crashed.
  return 0;
}

async function cmdDemo(args: Args): Promise<number> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const template = path.resolve(here, '..', 'fixtures', 'demo-repo');
  const dest = path.resolve(args.positional[0] ?? './emend-demo');

  if (await exists(dest)) {
    const entries = await readdir(dest);
    if (entries.length > 0) {
      console.error(c.red(`  ${dest} already exists and is not empty. Pick another path.`));
      return 1;
    }
  }

  console.log(c.dim(`  scaffolding demo repo at ${dest}`));
  await mkdir(dest, { recursive: true });
  for (const entry of ['package.json', 'tsconfig.json', '.gitignore', 'src', 'test']) {
    const from = path.join(template, entry);
    if (await exists(from)) {
      await cp(from, path.join(dest, entry), { recursive: true });
    }
  }

  console.log(c.dim('  npm install (pinning zod 3.22.4 — the version with drift)'));
  await execFileAsync('npm', ['install', '--no-audit', '--no-fund', '--silent'], { cwd: dest });

  console.log(c.dim('  git init + initial commit'));
  await execFileAsync('git', ['-C', dest, 'init', '-q']);
  await execFileAsync('git', ['-C', dest, 'add', '-A']);
  await execFileAsync('git', [
    '-C', dest, '-c', 'user.email=demo@emend.local', '-c', 'user.name=Emend Demo',
    'commit', '-q', '-m', 'Initial commit: checkout service on zod 3.22.4',
  ]);

  console.log('');
  console.log(c.green(`  Demo repo ready at ${dest}`));
  console.log('');
  console.log('  Try:');
  console.log(c.bold(`    emend scan ${dest} --only zod`));
  console.log(c.bold(`    emend fix ${dest}`));
  console.log(c.bold(`    emend serve`));
  console.log('');
  return 0;
}

function usage(): void {
  console.log(`
${c.bold('emend')} — detect API drift, locate affected call sites, verify migrations

${c.bold('USAGE')}
  emend <command> [options]

${c.bold('COMMANDS')}
  scan <repo>     Diff installed vs latest dependency surfaces and locate
                  affected call sites in the repository.
    --only a,b      Restrict to specific packages
    --no-dev        Skip devDependencies
    --all           Show up-to-date and skipped packages too
    --contracts[=d] Also check outbound HTTP calls against each vendor's
                    published API description. Makes network requests — one
                    resolution per host found in your source. Optionally names a
                    directory to cache descriptions in.
                    Set GITHUB_TOKEN: only a description from the provider's own
                    repository may be used to assert a call is broken, and
                    unauthenticated GitHub allows 60 requests an hour.
    --github-org p  Name a provider's GitHub organisation, as domain=org pairs
                    (stripe.com=stripe,openai.com=openai), for vendors whose own
                    records do not link back to their API domain. Per vendor:
                    one organisation for all of them would search the wrong
                    repositories and credit the wrong provider's description.
    --max-hosts n   How many distinct vendors one scan may resolve descriptions
                    for. 8 by default, because each one is outbound requests.
                    A repository that talks to a hundred services needs this
                    raised; the scan says how many it skipped either way.
    --since[=days]  Also compare each description against itself as it stood
                    that many days ago (365 by default) and report what changed that
                    reaches your code — including deprecations and newly
                    available capabilities, which reading today's description
                    alone can never show, because both are still in it.
                    Needs a GitHub-hosted description: that is what carries its
                    own history.
    --freshness     Also list packages that are behind their latest version where
                    nothing this repository calls changed. Never counted in the
                    headline: every repository has some, and producing them
                    requires no analysis.
    --lint          Also run hadolint over Dockerfiles and shellcheck over shell
                    scripts. Reports what is not installed rather than passing
                    over it in silence.
    --vulns         Also check the installed tree for known vulnerabilities.
                    Screens every package in the lockfile against OSV — no key,
                    no rate limit — and proposes the one bump that clears the
                    most advisories per package.
    --json          Machine-readable output

  fix <repo>      Plan, apply, and verify migrations in an isolated workspace.
                  Routes by detector: an API break goes to the planner and the
                  agent, a vulnerability to the remediation ladder, a lint
                  finding to the linter's own autofix, a stale package to a
                  plain bump. Everything is verified against a real baseline.
    --finding <id>  Fix one finding (default: all open findings)
    --no-agent      Deterministic only. By default a model attempts the findings
                    the planner declines, because a finding Emend will not try is
                    one somebody fixes by hand.
    --drive[=m]     Hand the whole fix to an opencode session pointed at Emend's
                    own MCP tools. Emend keeps the deterministic half — which
                    version clears the advisory, did the build survive, did the
                    vulnerable version actually leave the tree — and the session
                    does the repairing, which it can because it has edit rights.
                    Works on both the drift and vulnerability paths.
    --harness[=m]   Escalate to opencode when structured edits still leave the
                    build red, pinning provider/model if given. Every hunk it
                    writes is held to the same evidence rule; anything the
                    failure did not ask for is reverted. Slower and costlier.
    --review[=m]    Pin the reviewer's model. After a migration verifies, a
                    READ-ONLY model reads the repository and reports what the
                    diff cannot show: duplication against code it never loaded,
                    a shared module a caller leaked into, a call that now
                    returns different rows. It changes nothing; the notes go in
                    the pull request body.
    --no-review     Skip that pass. It is the only one that reads what a change
                    means rather than what it says, so skipping it is a choice.
    --keep          Leave the workspace on disk for inspection

  models          List models your configured LLM provider serves.
    --provider <p>  nebius | fireworks | together | groq | deepinfra |
                    openrouter | ollama | vllm

  pr <repo>       Render the pull request for a finding. Dry run by default.
    --finding <id>  Required
    --no-agent      Deterministic only, as for 'fix'
    --harness[=m]   As for 'fix' — pass it here too, or the re-run reports a
                    migration that verified under 'fix --harness' as unverified
    --create        Actually push a branch and open a DRAFT PR

  serve           Local dashboard for browsing findings.
    --port <n>      Default 4000

  demo [dir]      Scaffold a demo repository with real dependency drift.

  pins <repo>     Bring drifted version pins back in line — Dockerfile tags,
                  .nvmrc, engines and CI node versions — and verify the build.
                  Deterministic: no model is involved.
    --keep          Leave the workspace on disk for inspection.

  eval            Measure the agent against a corpus. Reports pass rate, clean
                  rate, edit ratio and error reduction per model, so an agent
                  change is a decision rather than a hope.
    --cases <f>     JSON corpus. Defaults to the built-in zod and recharts cases.
    --model <a,b>   Compare models. Omit to measure the deterministic path.
    --repeat <n>    Run each case n times. Migrations vary between runs, so a
                    single run is an anecdote rather than a measurement.
    --harness[=m]   Measure the escalation path too. A harness swaps the editing
                    engine, so its runs get their own row and are never averaged
                    into the model's — and the table gains the hunks its gate
                    kept and reverted.

${c.bold('EXAMPLE')}
  emend demo ./emend-demo
  emend scan ./emend-demo --only zod
  emend fix ./emend-demo

${c.bold('LLM AGENT')} ${c.dim('(any OpenAI-compatible endpoint; on by default)')}
  export EMEND_LLM_PROVIDER=openrouter    # or deepinfra, nebius, fireworks, groq, ollama...
  export OPENROUTER_API_KEY=...
  emend fix ./emend-demo                  # defaults to z-ai/glm-5.2

  ${c.dim('Without a key the run still works and says so, rather than quietly')}
  ${c.dim('delivering the deterministic half as though that were everything.')}

  ${c.dim('To use a different open-weight model:')}
  emend models                            # see what your provider serves
  export EMEND_LLM_MODEL=<id from above>

  ${c.dim('Detection, localisation and verification are always deterministic.')}
  ${c.dim('The model only proposes edits, and only where the planner declines.')}
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  try {
    switch (args.command) {
    case 'mcp':
      // Speaks JSON-RPC on stdout, so nothing else may write there.
      await serveMcp();
      break;
    case 'scan':
        process.exitCode = await cmdScan(args);
        break;
      case 'fix':
        process.exitCode = await cmdFix(args);
        break;
      case 'pr':
        process.exitCode = await cmdPr(args);
        break;
      case 'serve':
        process.exitCode = await cmdServe(args);
        break;
      case 'models':
        process.exitCode = await cmdModels(args);
        break;
      case 'demo':
        process.exitCode = await cmdDemo(args);
        break;
      case 'eval':
        process.exitCode = await cmdEval(args);
        break;
      case 'pins':
        process.exitCode = await cmdPins(args);
        break;
      default:
        usage();
        process.exitCode = args.command === 'help' ? 0 : 1;
    }
  } catch (err) {
    console.error('');
    console.error(c.red(`  error: ${(err as Error).message}`));
    if (process.env.EMEND_DEBUG) console.error((err as Error).stack);
    console.error('');
    process.exitCode = 1;
  }
}

await main();
