import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runnerFor, runPhase, parserFor } from '../src/verify.ts';
import type { CommandResult } from '../src/types.ts';

function repoWith(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-pyverify-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

test('a Python repository with mypy configured is claimed', async () => {
  const dir = repoWith({ 'pyproject.toml': '[tool.mypy]\nstrict = true\n' });
  try {
    assert.equal((await runnerFor(dir))?.id, 'python');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mypy.ini and pyrightconfig.json each claim on their own', async () => {
  for (const file of ['mypy.ini', 'pyrightconfig.json']) {
    const dir = repoWith({ [file]: '' });
    try {
      assert.equal((await runnerFor(dir))?.id, 'python', `${file} alone should claim`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('a Python repository with tests but no typechecker is NOT claimed', async () => {
  // The deliberate policy src/python/verify.ts's module doc states: Python has
  // no compile step, and pytest alone is not the proof a migration needs for a
  // language with no static safety net. A tests-only outcome was considered
  // and rejected because it runs through the same `compare`/`verificationPassed`
  // TypeScript uses, so it would have changed what TypeScript accepts too. This
  // repository has a real test suite and is still left unclaimed on purpose —
  // not claimed and weakly verified, not claimed at all.
  const dir = repoWith({
    'pyproject.toml': '[project]\nname = "demo"\n',
    'tests/test_x.py': 'def test_ok():\n    assert True\n',
  });
  try {
    assert.equal(await runnerFor(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unclaimed repository is skipped, never silently passed', async () => {
  const dir = repoWith({});
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

test('a pyproject.toml with no [tool.mypy] section does not claim', async () => {
  // Naming mypy is not configuring it. This pyproject.toml lists mypy as a
  // dependency to install — the way a project would to run it in CI — but
  // never writes a [tool.mypy] table. A substring search for the word "mypy"
  // anywhere in the file would incorrectly claim on this dependency entry
  // alone; `hasToolTable` in src/python/verify.ts is anchored to the
  // `[tool.mypy]` header for exactly this reason.
  const dir = repoWith({
    'pyproject.toml': '[project]\nname = "demo"\ndependencies = ["mypy"]\n',
  });
  try {
    assert.equal(await runnerFor(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mypy diagnostics are counted, and an unregistered runner counts nothing', () => {
  const result: CommandResult = {
    command: 'mypy .',
    ok: false,
    exitCode: 1,
    stdout: [
      'src/foo.py:10: error: Incompatible types in assignment (expression has type "int", variable has type "str")  [assignment]',
      'src/bar.py:20: error: Missing return statement  [return]',
    ].join('\n'),
    stderr: '',
  };
  const parser = parserFor('python');
  assert.ok(parser);
  assert.equal(parser.count(result), 2);

  // A runner id nothing registered must be absent here rather than fall
  // through to a pattern that cannot see its output. Zero is read downstream
  // as *not measured*, and an unregistered runner's diagnostics must report
  // that honestly rather than silently returning zero from a parser that was
  // never asked to read this format.
  assert.equal(parserFor('cargo'), undefined);
});
