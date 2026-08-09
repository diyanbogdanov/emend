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
import { fixFinding, fixFreshness, fixLint, fixPackage, fixPins, fixVulnerability } from './fix.ts';
import { Store } from './store.ts';
import { renderPrBody, renderPrTitle, createPullRequest, branchSlug } from './pr.ts';
import { assistantText } from './reviewharness.ts';
import { startServer } from './server.ts';
import { verificationPassed } from './verify.ts';
import { PROVIDERS, resolveLlmConfig, type LlmConfig } from './llm/providers.ts';
import { serve as serveMcp } from './mcp.ts';
import { openCodeHarness, drivingHarness, drivePrompt, harnessPermitted, type Harness } from './harness.ts';
import { resolveSpec, httpFetcher } from './specfetch.ts';
import { scanPackages, goSymbolRecord } from './osv.ts';
import { goSymbolSites, symbolTargets } from './goreach.ts';
import { LINT_ADAPTERS } from './lint.ts';
import { enrichAdvisories } from './advisory.ts';
import type { VulnerabilityOptions } from './detectors.ts';
import type { SpecCandidate } from './specs.ts';
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
 * The read-only repo-wide review, when one was asked for.
 *
 * A model with read access to the checkout, not a coding harness. opencode was
 * the obvious choice and was wrong twice: it resolves its model from the host's
 * own config — on a Copilot-authenticated machine that silently meant Claude,
 * contrary to running on open weights — and its read-only mode was configuration
 * to be verified afterwards rather than a capability it lacked. Here there is no
 * write tool to deny.
 *
 * `--review=<model>` pins one; bare `--review` uses the same model as the agent,
 * which is the open-weight default the provider preset carries.
 */
function reviewHarnessFrom(args: Args): Harness | undefined {
  const flag = args.flags.get('review');
  if (flag === undefined || flag === false) return undefined;
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
function contractsFrom(args: Args): { resolve: (v: { domain: string }) => Promise<SpecCandidate[]> } | undefined {
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
  const orgFlag = args.flags.get('github-org');
  const github = {
    ...(token ? { token } : {}),
    // Named by the operator when no automatic check can connect the two:
    // Stripe's organisation records `stripe.dev` as its site, not `stripe.com`.
    ...(typeof orgFlag === 'string' ? { org: orgFlag } : {}),
  };
  return { resolve: (vendor) => resolveSpec(vendor, { fetch, cacheDir, github }) };
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

function printScan(report: ScanReport, showAll: boolean): void {
  const { counts } = report;
  console.log('');
  console.log(c.bold(`  Emend scan — ${report.repo}`));
  console.log('');

  const analyzed = report.packages.filter((p) => p.status === 'analyzed');
  const withFindings = analyzed.filter((p) => p.findings.length > 0);

  for (const p of report.packages) {
    if (p.status === 'analyzed' && p.findings.length === 0 && !showAll) continue;
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
      console.log(`    ${c.cyan(pin.subject)} ${pin.version}`);
      console.log(c.dim(`      → ${pin.file}:${pin.line}  ${pin.text}`));
    }
    console.log(
      c.dim('    Reported, not checked: the current version is the vendor’s to publish.'),
    );
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
    printScan(report, args.flags.get('all') === true);
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
  const packageTargets = targets.filter(
    (f) =>
      f.detector !== 'version-pin' &&
      f.detector !== 'vulnerability' &&
      f.detector !== 'external-lint' &&
      f.detector !== 'freshness',
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
  const reviewHarness = reviewHarnessFrom(args);
  let anyVerified = false;

  // Each in its own workspace: getting one package out of the tree is a
  // self-contained change, and bundling them would make a single failure
  // withhold every other fix.
  for (const finding of vulnTargets) {
    console.log(
      c.bold(`  ${finding.pkg} ${finding.fromVersion} → ${finding.toVersion}`) +
        c.dim('  (vulnerability)'),
    );
    // `--drive` hands the whole loop to an opencode session pointed at Emend's
    // own MCP server. Emend keeps the deterministic half as tools it cannot
    // fake; the session does the repairing, which it can do because it has edit
    // rights and a loop of its own. This is what `runAgentRepair` was, moved to
    // something built for it.
    if (args.flags.get('drive')) {
      const permitted = harnessPermitted({ untrusted: args.flags.get('untrusted') === true });
      if (!permitted.ok) {
        console.log(c.yellow(`    declining to drive: ${permitted.reason}`));
        continue;
      }
      const model = args.flags.get('drive');
      const harness = drivingHarness({
        ...(typeof model === 'string' ? { model } : {}),
        emendCommand: [process.execPath, '--experimental-strip-types', fileURLToPath(import.meta.url), 'mcp'],
      });
      const availability = await harness.available();
      if (!availability.ok) {
        console.log(c.yellow(`    cannot drive: ${availability.reason}`));
        continue;
      }
      console.log(c.dim(`    driving ${harness.id} against emend's own tools`));
      const run = await harness.run(repoDir, {
        instruction: drivePrompt({ repo: repoDir, findingId: finding.id, pkg: finding.pkg }),
        failureOutput: '',
      });
      // Whatever it says, said plainly. There is no gate on this path — the
      // session owns the workspace — so the log is the whole account of what
      // happened and hiding any of it would be the wrong trade.
      const said = assistantText(run.log).trim();
      const summary = (run.summary ?? "").trim();
      if (summary) console.log(c.dim(`    ${summary.slice(0, 2000)}`));
      if (said) console.log(said.slice(0, 4000).split('\n').map((l) => `    ${l}`).join('\n'));
      if (!run.ok) console.log(c.red(`    ${run.error ?? 'the session failed'}`));
      if (run.ok && !said && !summary) console.log(c.yellow('    the session produced no output'));
      continue;
    }

    const vulnResult = await fixVulnerability(repoDir, finding, {
      keepWorkspace: args.flags.get('keep') === true,
      // Without this the repair loop is unreachable and a security bump that
      // breaks the build is reported as unfixable by the one tool here that
      // knows how to fix it.
      useAgent: args.flags.get('agent') === true,
      ...(reviewHarness ? { reviewHarness } : {}),
      onProgress: (m) => console.log(c.dim(`    ${m}`)),
    });
    // Why this package is in the tree at all — the first thing a reviewer asks
    // of a transitive advisory, and the reason bumping `express` for a CVE in
    // `qs` is an instruction rather than a non sequitur.
    if (vulnResult.remediation.kind === 'parent') {
      for (const route of vulnResult.remediation.paths) {
        console.log(c.dim(`    via  ${route.join(' → ')}`));
      }
    }
    // A repaired fix and a fix that never needed repair are not the same result,
    // and a reviewer reading the diff is entitled to know which one this is.
    // The repo-wide review's findings. Computed and then dropped on the floor
    // until now, which made the whole pass decorative — it is advisory output for
    // a human, so the human has to see it.
    for (const f of vulnResult.reviewNotes ?? []) {
      console.log(`    ${c.yellow(`[${f.severity}]`)} ${f.file}  ${c.dim(f.what)}`);
      console.log(c.dim(`        ${f.why}`));
    }
    if (vulnResult.agent) {
      const { attempts, finalErrors } = vulnResult.agent;
      console.log(
        c.dim(
          `    repaired the breaking upgrade in ${attempts.length} attempt(s), ` +
            `${vulnResult.agent.initialErrors} → ${finalErrors} error(s)`,
        ),
      );
    }
    const verified =
      vulnResult.verification !== null && verificationPassed(vulnResult.verification.outcome);
    // Two conditions, and both must hold. A green build with the vulnerable
    // version still installed is the failure most easily mistaken for success.
    const fixed = verified && vulnResult.resolved;
    if (fixed) {
      anyVerified = true;
      // Only on a verified fix. Recording an attempt would make the regression
      // guard fire on a package that was never actually repaired.
      store.recordVulnerabilityFixed(
        repoDir,
        finding.pkg,
        vulnResult.installedAfter ?? finding.toVersion,
        [finding.change.path],
      );
    }
    console.log(
      `    ${
        fixed
          ? c.green('FIXED')
          : vulnResult.remediation.kind === 'none'
            ? c.yellow('NO FIX AVAILABLE')
            : c.red('NOT FIXED')
      }  ${c.dim(vulnResult.verification?.summary ?? vulnResult.note ?? '')}`,
    );
    // Never silent. An override forces a version a dependency did not ask for,
    // and a reviewer has to know a constraint was overridden rather than met.
    if (vulnResult.overrode) {
      console.log(
        c.yellow(
          `    forced via an overrides entry — no dependency's own range selects ${finding.toVersion}`,
        ),
      );
    }
    if (vulnResult.note && !fixed) console.log(c.yellow(`    ${vulnResult.note}`));
    if (vulnResult.workspaceDir) {
      console.log(c.dim(`    workspace kept at ${vulnResult.workspaceDir}`));
    }
  }

  // One workspace for all of them: the repairs are independent text edits in
  // separate files, and a single verification answers for the lot.
  if (lintTargets.length > 0) {
    console.log(c.bold('  lint') + c.dim(`  (${lintTargets.length} finding(s))`));
    const lintResult = await fixLint(repoDir, lintTargets, {
      keepWorkspace: args.flags.get('keep') === true,
      useAgent: args.flags.get('agent') === true,
      onProgress: (m) => console.log(c.dim(`    ${m}`)),
    });
    const ok =
      lintResult.verification !== null && verificationPassed(lintResult.verification.outcome);
    if (ok) anyVerified = true;
    if (lintResult.repaired.length > 0 || lintResult.agentEdits > 0) {
      const what = [
        lintResult.repaired.length > 0 ? `${lintResult.repaired.length} file(s) by shellcheck` : '',
        lintResult.agentEdits > 0 ? `${lintResult.agentEdits} edit(s) by the model` : '',
      ]
        .filter(Boolean)
        .join(', ');
      console.log(`    ${ok ? c.green('VERIFIED') : c.red('NOT VERIFIED')}  ${c.dim(what)}`);
    }
    // Never silent about the half nothing can repair.
    if (lintResult.unrepairable.length > 0) {
      console.log(
        c.yellow(
          `    ${lintResult.unrepairable.length} finding(s) still unrepaired${args.flags.get('agent') === true ? '' : ' — re-run with --agent to let the model try'}:`,
        ),
      );
      for (const u of lintResult.unrepairable.slice(0, 5)) {
        console.log(c.dim(`      ${u.finding.change.path} — ${u.reason}`));
      }
    }
    if (lintResult.caveat) console.log(c.yellow(`    ${lintResult.caveat}`));
    if (lintResult.workspaceDir) console.log(c.dim(`    workspace kept at ${lintResult.workspaceDir}`));
  }

  for (const finding of freshTargets) {
    console.log(
      c.bold(`  ${finding.pkg} ${finding.fromVersion} → ${finding.toVersion}`) +
        c.dim('  (behind latest)'),
    );
    const freshResult = await fixFreshness(repoDir, finding, {
      keepWorkspace: args.flags.get('keep') === true,
      onProgress: (m) => console.log(c.dim(`    ${m}`)),
    });
    const ok =
      freshResult.verification !== null && verificationPassed(freshResult.verification.outcome);
    if (ok) anyVerified = true;
    console.log(
      `    ${ok ? c.green('VERIFIED') : c.red('NOT VERIFIED')}  ${c.dim(freshResult.verification?.summary ?? '')}`,
    );
    if (freshResult.workspaceDir) console.log(c.dim(`    workspace kept at ${freshResult.workspaceDir}`));
  }

  if (pinTargets.length > 0) {
    console.log(c.bold(`  version pins`) + c.dim(`  (${pinTargets.length} drifted)`));
    const pinResult = await fixPins(repoDir, {
      keepWorkspace: args.flags.get('keep') === true,
      onProgress: (m) => console.log(c.dim(`    ${m}`)),
    });
    const ok = verificationPassed(pinResult.verification.outcome);
    console.log(
      `    ${ok ? c.green('VERIFIED') : c.red(pinResult.verification.outcome.toUpperCase())}` +
        `  ${pinResult.appliedEdits} pin edit(s)`,
    );
    if (ok && pinResult.appliedEdits > 0) anyVerified = true;
    console.log('');
  }

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

    // Same as the vulnerability path: hand the loop to an opencode session
    // pointed at Emend's own tools. Deleting runAgentRepair left drift with no
    // repair mechanism at all — `--agent` became a no-op here — and drift is the
    // thesis, so it needed this more than vulnerabilities did.
    if (args.flags.get('drive')) {
      const permitted = harnessPermitted({ untrusted: args.flags.get('untrusted') === true });
      if (!permitted.ok) {
        console.log(c.yellow(`    declining to drive: ${permitted.reason}`));
        return 1;
      }
      const model = args.flags.get('drive');
      const driver = drivingHarness({
        ...(typeof model === 'string' ? { model } : {}),
        emendCommand: [process.execPath, '--experimental-strip-types', fileURLToPath(import.meta.url), 'mcp'],
      });
      const availability = await driver.available();
      if (!availability.ok) {
        console.log(c.yellow(`    cannot drive: ${availability.reason}`));
        return 1;
      }
      console.log(c.dim(`    driving ${driver.id} against emend's own tools`));
      const run = await driver.run(repoDir, {
        instruction: drivePrompt({
          repo: repoDir,
          findingId: first.id,
          pkg: first.pkg,
        }),
        failureOutput: '',
      });
      const said = assistantText(run.log).trim();
      const summary = (run.summary ?? '').trim();
      if (summary) console.log(c.dim(`    ${summary.slice(0, 2000)}`));
      if (said) console.log(said.slice(0, 4000).split('\n').map((l) => `    ${l}`).join('\n'));
      if (!run.ok) console.log(c.red(`    ${run.error ?? 'the session failed'}`));
      if (run.ok && !said && !summary) console.log(c.yellow('    the session produced no output'));
      return run.ok ? 0 : 1;
    }

    const harness = harnessFrom(args);
    const reviewHarness = reviewHarnessFrom(args);
    const result = await fixPackage(repoDir, findings, {
      keepWorkspace: args.flags.get('keep') === true,
      useAgent: args.flags.get('agent') === true,
      ...(harness ? { harness } : {}),
      ...(reviewHarness ? { reviewHarness } : {}),
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
          `    ${result.unplanned.length} finding(s) had no deterministic fix — re-run with --agent, or fix by hand:`,
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
    if (verificationPassed(v.outcome)) anyVerified = true;

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
      store.recordRun(f.id, repoDir, v, rationale, result.diff, agent);
    }
    console.log('');
  }

  store.close();
  console.log(c.dim(`  Run ${c.bold('emend pr <repo> --finding <id>')} to preview a pull request.`));
  console.log('');
  return anyVerified ? 0 : 1;
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
    useAgent: args.flags.get('agent') === true,
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
  const body = renderPrBody(result);

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
    --github-org o  Name the provider's GitHub organisation, for vendors whose
                    own records do not link back to their API domain.
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
    --agent         Let an LLM attempt findings the deterministic planner declines
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
    --review[=m]    After a migration verifies, let a READ-ONLY model read the
                    repository and report what the diff alone cannot show:
                    duplication against code it never loaded, a shared module a
                    caller leaked into, a file this change made unreadable. It
                    changes nothing; the notes go in the pull request body.
    --keep          Leave the workspace on disk for inspection

  models          List models your configured LLM provider serves.
    --provider <p>  nebius | fireworks | together | groq | deepinfra |
                    openrouter | ollama | vllm

  pr <repo>       Render the pull request for a finding. Dry run by default.
    --finding <id>  Required
    --agent         Let the model attempt what the planner declined
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

${c.bold('OPTIONAL LLM AGENT')} ${c.dim('(any OpenAI-compatible endpoint)')}
  export EMEND_LLM_PROVIDER=openrouter    # or deepinfra, nebius, fireworks, groq, ollama...
  export OPENROUTER_API_KEY=...
  emend fix ./emend-demo --agent          # defaults to z-ai/glm-5.2

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
