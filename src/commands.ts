/**
 * Spawning a verification command, and building the result for one that never ran.
 *
 * Split out of verify.ts so a language runner can use these without importing
 * verify.ts for them. verify.ts imports every runner to register it
 * (src/python/verify.ts among them); a runner importing `runCommand`/`skipped`
 * back from verify.ts would make that a genuine two-file import cycle, not
 * just an untidy one.
 */

import { spawn } from 'node:child_process';
import type { CommandResult } from './types.ts';

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

/**
 * A `CommandResult` for a step that never ran, with the reason recorded rather
 * than left to be guessed from an empty stdout/stderr.
 *
 * Exported so every runner can build its own skip results in its own words —
 * `npmRunner` labels its skip `npm test`; a Rust runner would label its
 * `cargo test`. See "a runner names its own skip labels rather than npm's" in
 * test/verifyrunner.test.ts for the bug this convention replaced: `runPhase`
 * used to hardcode the `npm test` label for every runner's skip.
 */
export function skipped(command: string, reason: string): CommandResult {
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
