import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyLintPatch, repairableFiles } from '../src/lint.ts';
import type { LintFinding } from '../src/lint.ts';

const run = promisify(execFile);

async function gitRepo(files: Record<string, string>): Promise<{ dir: string; cleanup: () => void }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-lintfix-'));
  await run('git', ['init', '-b', 'main', dir]);
  await run('git', ['-C', dir, 'config', 'user.email', 't@example.com']);
  await run('git', ['-C', dir, 'config', 'user.name', 'Test']);
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
  await run('git', ['-C', dir, 'add', '-A']);
  await run('git', ['-C', dir, 'commit', '-m', 'base']);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function finding(over: Partial<LintFinding> = {}): LintFinding {
  return {
    file: 'run.sh',
    line: 4,
    column: 8,
    code: 'SC2086',
    level: 'info',
    message: 'Double quote to prevent globbing',
    tool: 'shellcheck',
    ...over,
  };
}

const UNQUOTED = '#!/bin/bash\nfiles=$(ls)\nfor f in $files; do\n  echo $f\ndone\n';

// ---------------------------------------------------------------------------
// Which findings anything can repair
// ---------------------------------------------------------------------------

test('only the tool that ships an autofix offers files to repair', () => {
  // shellcheck has `--format=diff`; hadolint has nothing equivalent. Claiming a
  // repair path for hadolint would mean inventing Dockerfile edits, which is the
  // agent's job and not a deterministic one.
  const files = repairableFiles([
    finding({ file: 'run.sh', tool: 'shellcheck' }),
    finding({ file: 'Dockerfile', tool: 'hadolint', code: 'DL3006' }),
  ]);
  assert.deepEqual(files, ['run.sh']);
});

test('a file is offered once however many findings it has', () => {
  const files = repairableFiles([
    finding({ file: 'run.sh', code: 'SC2086' }),
    finding({ file: 'run.sh', code: 'SC2034' }),
  ]);
  assert.deepEqual(files, ['run.sh']);
});

test('nothing repairable yields nothing to run', () => {
  assert.deepEqual(repairableFiles([finding({ tool: 'hadolint' })]), []);
});

// ---------------------------------------------------------------------------
// Applying what the tool itself proposes
// ---------------------------------------------------------------------------

test('shellcheck’s own patch is applied, not a reconstruction of it', async () => {
  // It emits a unified diff. Rebuilding one from the `replacements` array —
  // column offsets, insertion points, precedence — is a second implementation of
  // something the tool already did correctly.
  const repo = await gitRepo({ 'run.sh': UNQUOTED });
  try {
    const result = await applyLintPatch(repo.dir, ['run.sh']);
    assert.equal(result.applied, true, result.error ?? '');
    const after = readFileSync(path.join(repo.dir, 'run.sh'), 'utf8');
    assert.match(after, /echo "\$f"/);
    // Nothing else touched.
    assert.match(after, /files=\$\(ls\)/);
  } finally {
    repo.cleanup();
  }
});

test('a file with nothing to fix is left exactly as it was', async () => {
  const clean = '#!/bin/bash\necho "hello"\n';
  const repo = await gitRepo({ 'run.sh': clean });
  try {
    const result = await applyLintPatch(repo.dir, ['run.sh']);
    assert.equal(result.applied, false);
    assert.equal(result.error, undefined, 'nothing to fix is not a failure');
    assert.equal(readFileSync(path.join(repo.dir, 'run.sh'), 'utf8'), clean);
  } finally {
    repo.cleanup();
  }
});

test('a patch that will not apply leaves the file alone and says so', async () => {
  // `git apply` is atomic per invocation, so a refused patch changes nothing.
  // Reporting success here would claim a repair that did not happen.
  const repo = await gitRepo({ 'run.sh': UNQUOTED });
  try {
    const result = await applyLintPatch(repo.dir, ['does-not-exist.sh']);
    assert.equal(result.applied, false);
    assert.equal(readFileSync(path.join(repo.dir, 'run.sh'), 'utf8'), UNQUOTED);
  } finally {
    repo.cleanup();
  }
});
