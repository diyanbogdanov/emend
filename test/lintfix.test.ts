import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyLintPatch, repairableFiles } from '../src/lint.ts';
import { selectLintEdits } from '../src/llm/agent.ts';
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

// ---------------------------------------------------------------------------
// The agent's half: what hadolint cannot fix
// ---------------------------------------------------------------------------

test('an edit on a flagged line is kept', () => {
  const sources = new Map([['Dockerfile', 'FROM node\nRUN apt-get install curl\nUSER node\n']]);
  const { keep, dropped } = selectLintEdits(
    [{ file: 'Dockerfile', find: 'FROM node', replace: 'FROM node:22', reason: 'DL3006' }],
    [{ file: 'Dockerfile', line: 1 }],
    sources,
  );
  assert.equal(keep.length, 1);
  assert.equal(dropped.length, 0);
});

test('an edit nowhere near a finding is withheld', () => {
  // Stricter than the migration gate, and deliberately. That one lets an edit
  // through when it finds neither diagnostic nor call site, because a bump can
  // break a file the walk never visited — there is a hidden cause to allow for.
  // Lint has none: the findings are the complete list of what is wrong, so an
  // edit away from all of them is the model rewriting something nobody asked
  // about.
  const sources = new Map([
    ['Dockerfile', 'FROM node:22\nRUN echo a\nRUN echo b\nRUN echo c\nRUN echo d\nUSER node\n'],
  ]);
  const { keep, dropped } = selectLintEdits(
    [{ file: 'Dockerfile', find: 'USER node', replace: 'USER 1000', reason: 'tidier' }],
    [{ file: 'Dockerfile', line: 1 }],
    sources,
  );
  assert.deepEqual(keep, []);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0]?.reason ?? '', /carry no linter finding/);
});

test('a fix spanning the continuation of a flagged line is kept', () => {
  // A linter reports the head of a construct — the `RUN` — while the fix often
  // spans its continuations, so the window is generous by a couple of lines.
  const sources = new Map([
    ['Dockerfile', 'FROM node:22\nRUN apt-get update \\\n  && apt-get install -y curl \\\n  && rm -rf /var/lib/apt/lists/*\n'],
  ]);
  const { keep } = selectLintEdits(
    [{ file: 'Dockerfile', find: '&& apt-get install -y curl', replace: '&& apt-get install -y --no-install-recommends curl', reason: 'DL3015' }],
    [{ file: 'Dockerfile', line: 2 }],
    sources,
  );
  assert.equal(keep.length, 1);
});

test('an edit that cannot be located is left for the applicator to refuse', () => {
  // One place decides and one reason is reported, rather than two rejections
  // with different wording for the same cause.
  const { keep } = selectLintEdits(
    [{ file: 'Dockerfile', find: 'NOT PRESENT', replace: 'x', reason: 'y' }],
    [{ file: 'Dockerfile', line: 1 }],
    new Map([['Dockerfile', 'FROM node:22\n']]),
  );
  assert.equal(keep.length, 1);
});
