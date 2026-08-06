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
import { fileURLToPath } from 'node:url';
import { scanRepo } from './analyze.ts';
import { readRepo } from './inventory.ts';
import { fixFinding, fixPackage, fixPins } from './fix.ts';
import { Store } from './store.ts';
import { renderPrBody, renderPrTitle, createPullRequest, branchSlug } from './pr.ts';
import { startServer } from './server.ts';
import { verificationPassed } from './verify.ts';
import { PROVIDERS, resolveLlmConfig } from './llm/providers.ts';
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
import type { Finding, ScanReport } from './types.ts';

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

function severityLabel(sev: string): string {
  if (sev === 'breaking') return c.red('breaking');
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

    const header = `  ${c.bold(p.pkg)} ${c.dim(`${p.fromVersion ?? '?'} → ${p.toVersion ?? '?'}`)}`;
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
    console.log(c.green('  No findings: no tracked API change intersects this codebase.'));
  }

  // Reported in its own block, above the summary but never inside its counts. A
  // drifted Dockerfile tag is real and worth fixing, and it is not a change in
  // anybody's public API — folding it into "breaking" would overstate both and
  // blunt the one number that makes a scan worth reading.
  if (report.pinConflicts.length > 0) {
    console.log('');
    console.log(`  ${c.bold('Version pins that disagree')}`);
    for (const conflict of report.pinConflicts) {
      console.log(
        conflict.expected
          ? `    ${c.yellow('drift')}      ${conflict.subject} should be ${conflict.expected} (${conflict.authority})`
          : `    ${c.yellow('conflict')}   ${conflict.subject} is pinned inconsistently and nothing declares the intent`,
      );
      for (const pin of conflict.pins) {
        console.log(c.dim(`      → ${pin.file}:${pin.line}  ${pin.text}`));
      }
    }
  }

  console.log('');
  console.log(
    `  ${c.bold('Summary')}  ${counts.breaking} breaking · ${counts.deprecation} deprecated · ${counts.callSites} call site(s)`,
  );
  if (counts.pinConflicts > 0) {
    console.log(c.dim(`           ${counts.pinConflicts} version pin(s) disagree`));
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
  const report = await scanRepo(repoDir, {
    ...(only ? { only } : {}),
    includeDev: args.flags.get('no-dev') !== true,
    onProgress: args.flags.get('json') === true ? () => {} : (m) => console.log(c.dim(`  ${m}`)),
  });

  if (args.flags.get('json') === true) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printScan(report, args.flags.get('all') === true);
  }

  const store = new Store();
  store.recordScan(report, repo.name);
  store.close();

  if (args.flags.get('json') !== true) {
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

  // Group by package: a version bump is atomic, so every finding for one
  // package must be fixed together in one workspace and land as one PR.
  const byPackage = new Map<string, Finding[]>();
  for (const f of targets) {
    const list = byPackage.get(f.pkg) ?? [];
    list.push(f);
    byPackage.set(f.pkg, list);
  }

  console.log('');
  let anyVerified = false;

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

    const result = await fixPackage(repoDir, findings, {
      keepWorkspace: args.flags.get('keep') === true,
      useAgent: args.flags.get('agent') === true,
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
  const result = await fixFinding(repoDir, stored.finding, {
    // Without this, `emend pr --agent` silently re-ran deterministic-only and
    // rendered "unverified / needs a human" for a migration that had just
    // verified under `emend fix --agent`.
    useAgent: args.flags.get('agent') === true,
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
          const outcome = await runCase(evalCase, dir, label, { useAgent: Boolean(model) });
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
    --json          Machine-readable output

  fix <repo>      Plan, apply, and verify migrations in an isolated workspace.
    --finding <id>  Fix one finding (default: all open findings)
    --agent         Let an LLM attempt findings the deterministic planner declines
    --keep          Leave the workspace on disk for inspection

  models          List models your configured LLM provider serves.
    --provider <p>  nebius | fireworks | together | groq | deepinfra |
                    openrouter | ollama | vllm

  pr <repo>       Render the pull request for a finding. Dry run by default.
    --finding <id>  Required
    --agent         Let the model attempt what the planner declined
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
