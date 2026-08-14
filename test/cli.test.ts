import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { emendPath } from '../src/paths.ts';

const execFileAsync = promisify(execFile);

/**
 * Run the CLI the way a shell does, and report the exit code rather than throw.
 *
 * Through `bin/emend.mjs`, because the launcher is part of what is being
 * checked: it decides which of the sources and the bundle runs, and a test that
 * imported `cli.ts` would check neither of those decisions.
 */
async function run(...args: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [emendPath('bin', 'emend.mjs'), ...args]);
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '' };
  }
}

test('asking for help succeeds, in every spelling of it', async () => {
  // Exit codes, not output. `emend --help` printed perfect usage and exited 1
  // for the whole life of the CLI, because the first argv entry is the command
  // and `--help` in that slot matched no command. Nothing caught it: every
  // manual check pipes the output somewhere, and a pipeline reports the exit
  // code of its *last* stage, so `emend --help | head` is 0 no matter what the
  // CLI said. It took a packaging smoke test running the bare command to see it.
  for (const spelling of [[], ['help'], ['--help'], ['-h']]) {
    const { code, stdout } = await run(...spelling);
    assert.equal(code, 0, `\`emend ${spelling.join(' ')}\` must exit 0`);
    assert.match(stdout, /USAGE/, 'and must actually print the usage');
  }
});

test('a command Emend does not have is still a failure', async () => {
  // The other half, and the reason this is not just `exitCode = 0`. A typo has
  // to be distinguishable from a request — `emend scna` in a script must stop
  // it, not print usage and carry on as though the work were done.
  const { code, stdout } = await run('frobnicate');
  assert.equal(code, 1);
  assert.match(stdout, /USAGE/, 'usage is still the useful thing to show');
});

test('asking for the version answers it, in every spelling of it', async () => {
  // The same failure as `--help`, in the question a bug report is built from:
  // every spelling fell through to `default`, printed the usage and exited 1.
  // An install check — `emend --version >/dev/null` — therefore reported Emend
  // as broken on a working install, and the issue template that asks reporters
  // to quote it was asking for output they could not get.
  for (const spelling of ['version', '--version', '-v']) {
    const { code, stdout } = await run(spelling);
    assert.equal(code, 0, `\`emend ${spelling}\` must exit 0`);
    // The manifest's version, not merely non-empty: reading it from anywhere
    // else is how the number goes stale without anyone noticing.
    assert.match(
      stdout.trim(),
      /^\d+\.\d+\.\d+/,
      'and must print the version rather than the usage',
    );
  }
});
