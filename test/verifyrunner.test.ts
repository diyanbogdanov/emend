import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runnerFor, runPhase, parserFor, countDiagnostics, type VerifyRunner } from '../src/verify.ts';
import type { CommandResult } from '../src/types.ts';

function fakeRunner(id: string, claims: boolean): VerifyRunner {
  return {
    id,
    applies: async () => claims,
    run: async () => ({
      typecheck: { command: `${id} check`, ok: true, exitCode: 0, stdout: '', stderr: '' },
      test: { command: `${id} test`, ok: true, exitCode: 0, stdout: '', stderr: '' },
    }),
  };
}

test('the runner is chosen by what the repository is, not by a flag', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-verifyrunner-'));
  try {
    writeFileSync(path.join(dir, 'package.json'), '{}');
    const runner = await runnerFor(dir);
    assert.equal(runner?.id, 'npm');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a repository no runner claims reports no runner, not a passing one', async () => {
  // `unverified` is a real outcome; returning a trivially-passing runner would
  // turn "we could not tell" into "this works".
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-verifyrunner-none-'));
  try {
    assert.equal(await runnerFor(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the claiming runner wins over one that declines', async () => {
  // Routed through runnerFor with both a claiming and a declining runner
  // precisely so deleting the `applies` check inside it makes this go red.
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-verifyrunner-claim-'));
  try {
    const runner = await runnerFor(dir, [fakeRunner('declining', false), fakeRunner('cargo', true)]);
    assert.equal(runner?.id, 'cargo');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a runner names its own skip labels rather than npm's", async () => {
  // `skipped('npm test', …)` used to be hardcoded inside `runPhase`, so a Rust
  // repository would have reported skipping a command it has no concept of.
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-verifyrunner-labels-'));
  try {
    const runner = await runnerFor(dir, [fakeRunner('cargo', true)]);
    assert.ok(runner);
    const phase = await runner.run(dir, {});
    assert.equal(phase.test.command, 'cargo test');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unclaimed repository is skipped, never silently passed', async () => {
  // The load-bearing case. runPhase has 14 call sites feeding compare, whose
  // outcome decides whether a migration earns a pull request — a phase that
  // wrongly looks like it ran and passed would force an unproven migration
  // onto a live PR whose body implies verification.
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-verifyrunner-unclaimed-'));
  try {
    const phase = await runPhase(dir);
    assert.equal(phase.typecheck.skipped, true);
    assert.equal(phase.test.skipped, true);
    assert.equal(phase.typecheck.ok, false);
    assert.equal(phase.test.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parserFor('npm') counts the same as countDiagnostics on the same input", () => {
  // parserFor is the seam a caller is meant to go through; countDiagnostics is
  // the npm parser's own implementation, registered under it. If these ever
  // disagreed, fix.ts's afterBump/afterRepair numbers would depend on which of
  // the two happened to be called, for no reason a reader could see.
  const result: CommandResult = {
    command: 'tsc --noEmit',
    ok: false,
    exitCode: 1,
    stdout: 'src/schema.ts(28,15): error TS2554: Expected 1 arguments, but got 2.\n',
    stderr: '',
  };
  const parser = parserFor('npm');
  assert.ok(parser);
  assert.equal(parser.count(result), countDiagnostics(result));
});

test("parserFor('cargo') is undefined, not tsc's patterns applied to cargo's output", () => {
  // A runner id nothing registered must be absent here rather than fall
  // through to a pattern that cannot see its output: cargo's own diagnostics
  // (`--message-format=json`) match neither of countDiagnostics's patterns, so
  // routing an unregistered id through them anyway would silently undercount
  // — usually to 0 — rather than report honestly that nothing measured it.
  assert.equal(parserFor('cargo'), undefined);
});
