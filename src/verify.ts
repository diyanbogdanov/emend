/**
 * Runs verification commands and compares before/after.
 *
 * The baseline run is the load-bearing part. Without it, a repository whose tests
 * were already failing would have every failure blamed on Emend's edit — and a
 * tool that cries regression on a red repo gets uninstalled immediately.
 */

import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CommandResult, VerificationReport, VerifyOutcome } from './types.ts';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const label = `${command} ${args.join(' ')}`.trim();
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({
        command: label,
        ok: false,
        exitCode: null,
        stdout,
        stderr: stderr + `\n[emend] timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > 200_000) stdout = stdout.slice(-200_000);
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command: label,
        ok: false,
        exitCode: null,
        stdout,
        stderr: stderr + `\n[emend] failed to spawn: ${err.message}`,
      });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ command: label, ok: code === 0, exitCode: code, stdout, stderr });
    });
  });
}

function skipped(command: string, reason: string): CommandResult {
  return {
    command,
    ok: false,
    exitCode: null,
    stdout: '',
    stderr: '',
    skipped: true,
    skipReason: reason,
  };
}

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

export async function runPhase(
  dir: string,
  options: PhaseOptions = {},
): Promise<VerifyPhase> {
  return {
    typecheck: await runTypecheck(dir),
    test: options.skipTests
      ? skipped('npm test', 'tests are not run by the hosted analyser; your CI runs them')
      : await runTests(dir),
  };
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
 * Whether a migration has earned a pull request.
 *
 * An allowlist, not a denylist. The CLI previously refused only on `regression`,
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
export function readyForPullRequest(outcome: VerifyOutcome): boolean {
  return outcome === 'verified' || outcome === 'typecheck-only';
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
    summary = 'Baseline passed and the post-change run passed: typecheck and tests are green.';
  }

  return { outcome, baseline, post, summary };
}
