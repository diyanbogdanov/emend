/**
 * Runs verification commands and compares before/after.
 *
 * The baseline run is the load-bearing part. Without it, a repository whose tests
 * were already failing would have every failure blamed on Emend's edit — and a
 * tool that cries regression on a red repo gets uninstalled immediately.
 */

import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { runCommand, skipped } from './commands.ts';
import { pythonRunner, pythonParser } from './python/verify.ts';
import type { CommandResult, VerificationReport, VerifyOutcome } from './types.ts';

// Re-exported: this used to be defined here, and src/apply.ts still imports its
// package-manager command runner from this module. Moved to commands.ts so a
// language runner can use it without importing verify.ts back (see that
// module's doc) — the export path stays the same so nothing else moves.
export { runCommand };

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function readScripts(dir: string): Promise<Record<string, string>> {
  try {
    const manifest = JSON.parse(
      await readFile(path.join(dir, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    return manifest.scripts ?? {};
  } catch {
    return {};
  }
}

export async function runTypecheck(dir: string): Promise<CommandResult> {
  const scripts = await readScripts(dir);
  if (scripts['typecheck']) return runCommand('npm', ['run', '--silent', 'typecheck'], dir);
  if (scripts['tsc']) return runCommand('npm', ['run', '--silent', 'tsc'], dir);
  if (await exists(path.join(dir, 'tsconfig.json'))) {
    return runCommand('npx', ['--no-install', 'tsc', '--noEmit'], dir);
  }
  return skipped('typecheck', 'no typecheck script and no tsconfig.json');
}

export async function runTests(dir: string): Promise<CommandResult> {
  const scripts = await readScripts(dir);
  if (!scripts['test']) return skipped('npm test', 'no test script in package.json');
  // npm's default placeholder test script exits 1 and means "no tests".
  if (/no test specified/i.test(scripts['test'])) {
    return skipped('npm test', 'package.json has npm\'s placeholder test script');
  }
  return runCommand('npm', ['test', '--silent'], dir);
}

export interface VerifyPhase {
  typecheck: CommandResult;
  test: CommandResult;
}

export interface PhaseOptions {
  /**
   * Never invoke the repository's test script.
   *
   * Typechecking parses source; running tests executes it. The hosted service
   * analyses repositories it does not trust, so it typechecks and leaves the
   * tests to the customer's own CI — which is both safer and better evidence,
   * since CI runs them in the environment they were written for.
   */
  skipTests?: boolean;
}

/**
 * One language's answer to "does this repository still build, and do its tests
 * still pass".
 *
 * `applies` is the routing decision and belongs to the runner, so adding a
 * language never means editing a list somewhere else. A repository no runner
 * claims yields `undefined` and, downstream, `unverified` — never a runner that
 * trivially passes.
 */
export interface VerifyRunner {
  id: string;
  /** Whether this runner understands `dir` well enough to verify it. */
  applies(dir: string): Promise<boolean>;
  /** Typecheck, and unless `options.skipTests`, test `dir` — in this runner's own terms. */
  run(dir: string, options: PhaseOptions): Promise<VerifyPhase>;
}

function npmRunner(): VerifyRunner {
  return {
    id: 'npm',

    // Both, because `runTypecheck` already falls back to `npx tsc --noEmit` on a
    // bare `tsconfig.json`. Gating on `package.json` alone would stop
    // typechecking repositories that are typechecked today.
    applies: async (dir) =>
      (await exists(path.join(dir, 'package.json'))) || (await exists(path.join(dir, 'tsconfig.json'))),

    async run(dir, options) {
      return {
        typecheck: await runTypecheck(dir),
        test: options.skipTests
          ? skipped('npm test', 'tests are not run by the hosted analyser; your CI runs them')
          : await runTests(dir),
      };
    },
  };
}

// Every runner a repository can be verified by. Registering one here is what
// makes a language verified at all: leaving one out is not a crash, it is
// `runnerFor` returning `undefined`, which `runPhase` turns into two skipped
// results rather than a runner that quietly never ran. `compare` reads that as
// `unverified`, never `verified` — the distinction that keeps an unproven
// migration from reaching a pull request.
//
// `runnerFor` takes the first claimant, so order picks a winner where more
// than one runner claims. `npmRunner` claims on `package.json` or
// `tsconfig.json`; `pythonRunner` claims only when mypy or pyright is
// configured (src/python/verify.ts's module doc explains why that gate
// exists). A repository with both is genuinely ambiguous. npm is listed
// first, so a polyglot repository gets its npm side verified and its Python
// side left unclaimed — a known limitation, stated here rather than a
// decision nobody made. `ecosystems.ts`'s `INVENTORIES` makes the identical
// tradeoff, for the identical reason, on the screening path.
const RUNNERS: VerifyRunner[] = [npmRunner(), pythonRunner()];

export async function runnerFor(
  dir: string,
  registry: VerifyRunner[] = RUNNERS,
): Promise<VerifyRunner | undefined> {
  for (const runner of registry) {
    if (await runner.applies(dir)) return runner;
  }
  return undefined;
}

export async function runPhase(
  dir: string,
  options: PhaseOptions = {},
): Promise<VerifyPhase> {
  const runner = await runnerFor(dir);
  if (!runner) {
    // Not a failure: nothing here understands this repository, and saying so is
    // the difference between `unverified` and a false pass.
    const why = 'no verification runner recognises this repository';
    return { typecheck: skipped('typecheck', why), test: skipped('test', why) };
  }
  return runner.run(dir, options);
}

/** A phase "passes" only when nothing that actually ran failed. */
function phasePassed(phase: VerifyPhase): boolean {
  for (const r of [phase.typecheck, phase.test]) {
    if (r.skipped) continue;
    if (!r.ok) return false;
  }
  return true;
}

function phaseRanAnything(phase: VerifyPhase): boolean {
  return !phase.typecheck.skipped || !phase.test.skipped;
}

/**
 * Whether an outcome means the change is good: the only states Emend acts on.
 *
 * The one place this set is written down. It decides three different things —
 * whether to stop retrying, whether to keep a tightening pass, and whether a
 * migration has earned a pull request — and every one of them was previously
 * spelled out by hand at its own call site.
 *
 * That is not a hypothetical risk. The CLI's copy refused only on `regression`,
 * which let `pre-existing-failure` and `unverified` through — states that mean
 * "we could not tell whether this works", not "this works". A broken baseline
 * (the repository's own tests already failing, or dependencies that do not match
 * its manifests) produced exactly that, and would have force-pushed an unproven
 * migration onto a live PR whose body implies verification.
 *
 * `typecheck-only` counts: it is the strongest result obtainable when a
 * repository has no runnable tests, and the hosted path already treats it as
 * success because it never runs tests at all.
 *
 * Stated as an allowlist so a future outcome fails closed rather than open.
 */
export function verificationPassed(outcome: VerifyOutcome): boolean {
  return outcome === 'verified' || outcome === 'typecheck-only';
}

/** `src/schema.ts(28,15): error TS2554: ...` — tsc's own format. */
const TSC_DIAGNOSTIC = /^\s*(\S+?)\((\d+),(\d+)\):\s*error\b/gm;

/** `src/schema.ts:28:15: error ...` — most other tools. */
const COLON_DIAGNOSTIC = /^\s*(\S+?):(\d+):(\d+):\s*error\b/gm;

/**
 * How many distinct places the compiler complained about.
 *
 * Deduplicated by file, line and column, which is what makes this a count of
 * *problems* rather than of lines printed. Both formats are tried against the
 * same output and a location seen twice is one diagnostic: tsc's pretty
 * printer repeats a location in its own error frame, and a monorepo runner
 * prefixes each line with the workspace, so the naive count of matches is
 * roughly double on exactly the repositories where the number matters.
 *
 * Only the typecheck is asked. A failing test prints whatever its author chose
 * to print, and counting that would compare two engines on how verbose their
 * assertion library is.
 *
 * Two formats and no more, which bounds what this can claim. `runTypecheck`
 * spawns through a pipe, so tsc leaves its pretty printer off and emits the
 * first of them; a repository whose own `typecheck` script forces `--pretty`,
 * or runs a checker that invents a third format, produces nothing either
 * pattern matches. That degrades to zero — and zero is exactly what the one
 * caller reads as *not measured*, so an unrecognised format costs the row its
 * error-reduction cell rather than filling it with a number nobody counted.
 */
export function countDiagnostics(result: CommandResult): number {
  if (result.skipped) return 0;
  const seen = new Set<string>();
  for (const pattern of [TSC_DIAGNOSTIC, COLON_DIAGNOSTIC]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(`${result.stdout}\n${result.stderr}`)) !== null) {
      const [, file, line, column] = match;
      if (file) seen.add(`${file}:${line}:${column}`);
    }
  }
  return seen.size;
}

/**
 * How many distinct places a compiler complained.
 *
 * Per-runner because the formats differ and the failure can be silent: Rust
 * emits structured JSON under `--message-format=json`, which matches neither
 * pattern above. mypy was assumed to share tsc's `file:line:col: error` shape
 * when this interface was written; checked by actually running mypy rather
 * than trusting that assumption, its default output omits the column
 * entirely (`file:line: error:`) unless `--show-column-numbers` is passed,
 * which the plain `mypy .` Emend runs does not — so `COLON_DIAGNOSTIC` above
 * matches none of it. `pythonParser` (src/python/verify.ts) has its own
 * pattern for that reason, keyed on file and line rather than file, line and
 * column. An unmatched format counts zero, and zero is read downstream as
 * *not measured* — so a runner without a parser must be absent here rather than
 * fall through to patterns that cannot see its output.
 */
export interface DiagnosticParser {
  /** Whether this parser knows how to read `runnerId`'s compiler output. */
  handles(runnerId: string): boolean;
  /** How many distinct diagnostics are in this result. */
  count(result: CommandResult): number;
}

// Every format this can read. Leaving a runner out here is silent by design:
// its diagnostics count as 0 rather than crash, which is why `parserFor`
// returning `undefined` — not a fallback parser — is what tells a caller the
// number is not measured rather than genuinely zero.
const PARSERS: DiagnosticParser[] = [
  { handles: (id) => id === 'npm', count: countDiagnostics },
  pythonParser(),
];

export function parserFor(runnerId: string): DiagnosticParser | undefined {
  return PARSERS.find((p) => p.handles(runnerId));
}

export function compare(baseline: VerifyPhase, post: VerifyPhase): VerificationReport {
  const baselineOk = phasePassed(baseline);
  const postOk = phasePassed(post);

  let outcome: VerifyOutcome;
  let summary: string;

  if (!phaseRanAnything(post)) {
    outcome = 'unverified';
    summary =
      'Nothing could be verified: the repository has neither a typecheck path nor a test script. This change is UNVERIFIED — do not treat it as safe.';
  } else if (!baselineOk && !postOk) {
    outcome = 'pre-existing-failure';
    summary =
      'The repository was already failing before any change was applied, so the post-change failure cannot be attributed to this migration. Fix the baseline first.';
  } else if (baselineOk && !postOk) {
    outcome = 'regression';
    summary =
      'Baseline passed and the post-change run failed: this migration introduces a regression. The plan was rejected.';
  } else if (post.test.skipped && !post.typecheck.skipped) {
    outcome = 'typecheck-only';
    // Why the tests did not run matters to a reader deciding whether to trust
    // this. "No test script" and "we declined to run your tests" are different
    // claims, and asserting the first when the second is true is simply false.
    summary =
      `Typecheck passes after the change, but the tests did not run (${post.test.skipReason ?? 'reason not recorded'}) — behaviour is NOT verified, only types.`;
  } else {
    outcome = 'verified';
    // Which of the two actually ran matters. This branch is reached whenever the
    // tests passed, including when the typecheck was skipped — and it used to say
    // "typecheck and tests are green" regardless, asserting a step that never ran.
    // `typecheck-only` above was always careful about the mirror case; this side
    // was not.
    summary = post.typecheck.skipped
      ? `Tests pass after the change, but types were not checked (${post.typecheck.skipReason ?? 'reason not recorded'}).`
      : 'Baseline passed and the post-change run passed: typecheck and tests are green.';
  }

  return { outcome, baseline, post, summary };
}
