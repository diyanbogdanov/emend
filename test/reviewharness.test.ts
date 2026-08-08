import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  reviewPrompt,
  parseReviewFindings,
  renderReviewFindings,
  harnessReview,
} from '../src/reviewharness.ts';
import { openCodeHarness } from '../src/harness.ts';
import type { Harness } from '../src/harness.ts';

const run = promisify(execFile);

async function repo(): Promise<{ dir: string; cleanup: () => void }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-rh-'));
  await run('git', ['init', '-b', 'main', dir]);
  await run('git', ['-C', dir, 'config', 'user.email', 't@e.com']);
  await run('git', ['-C', dir, 'config', 'user.name', 'T']);
  writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
  await run('git', ['-C', dir, 'add', '-A']);
  await run('git', ['-C', dir, 'commit', '-m', 'base']);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function fakeHarness(
  over: Partial<{ log: string; ok: boolean; onRun: (dir: string) => void; artifacts: string[] }> = {},
): Harness {
  return {
    id: 'fake',
    artifacts: over.artifacts ?? [],
    available: async () => ({ ok: true }),
    run: async (dir: string) => {
      over.onRun?.(dir);
      return { ok: over.ok ?? true, log: over.log ?? '{"findings": []}' };
    },
  } as unknown as Harness;
}

const FINDINGS = `I read the repository. Here is my conclusion.
{"findings": [
  {"severity": "duplication", "file": "src/util/money.ts", "what": "centsToUnits duplicates formatAmount", "why": "two roundings drift"},
  {"severity": "size", "file": "src/client.ts", "what": "now 1240 lines", "why": "no reader holds it"}
]}`;

// ---------------------------------------------------------------------------
// Read-only is the safety argument, so it is checked rather than assumed
// ---------------------------------------------------------------------------

test('the review harness denies the edit tool', () => {
  // The repair harness is gated by classifyHunks reading what it changed. This
  // one changes nothing, so it needs no gate — but only if the permission it
  // claims is the permission it gets.
  const config = JSON.parse(openCodeHarness({ readOnly: true }).envFor()['OPENCODE_CONFIG_CONTENT'] ?? '{}');
  assert.equal(config.permission.edit, 'deny');
  // And the repair harness must not have been made read-only by the same change.
  const repair = JSON.parse(openCodeHarness().envFor()['OPENCODE_CONFIG_CONTENT'] ?? '{}');
  assert.equal(repair.permission.edit, 'allow');
});

test('a read-only run that wrote anyway has its findings discarded', async () => {
  // A tool that ignored its own configuration is not a tool whose conclusions
  // are evidence. Reporting the findings and quietly reverting the write would
  // trust a process that already disregarded one instruction.
  const r = await repo();
  try {
    const result = await harnessReview({
      harness: fakeHarness({
        log: FINDINGS,
        onRun: (dir) => writeFileSync(path.join(dir, 'sneaky.ts'), 'export const x = 1;\n'),
      }),
      dir: r.dir,
      pkg: 'axios', fromVersion: '0.21.1', toVersion: '0.33.0', diff: '',
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.findings, [], 'findings from a run that wrote are not reported');
    assert.match(result.reason ?? '', /modified the workspace/);
  } finally {
    r.cleanup();
  }
});

test('a clean read-only run reports what it found', async () => {
  const r = await repo();
  try {
    const result = await harnessReview({
      harness: fakeHarness({ log: FINDINGS }),
      dir: r.dir,
      pkg: 'axios', fromVersion: '0.21.1', toVersion: '0.33.0', diff: '',
    });
    assert.equal(result.ok, true);
    assert.equal(result.findings.length, 2);
  } finally {
    r.cleanup();
  }
});

test('a harness that failed reports why rather than "nothing found"', async () => {
  // The distinction this codebase never blurs. An empty list from a failed run
  // reads as a clean bill of health.
  const r = await repo();
  try {
    const result = await harnessReview({
      harness: fakeHarness({ ok: false, log: 'crashed' }),
      dir: r.dir,
      pkg: 'axios', fromVersion: '0.21.1', toVersion: '0.33.0', diff: '',
    });
    assert.equal(result.ok, false);
    assert.ok((result.reason ?? '').length > 0);
  } finally {
    r.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Parsing a transcript, not a response
// ---------------------------------------------------------------------------

test('the concluding object wins over an earlier draft of it', () => {
  const log = `First thought: {"findings": [{"severity":"size","file":"x.ts","what":"a","why":"b"}]}
Then I actually read it.
{"findings": [{"severity":"duplication","file":"y.ts","what":"real","why":"b"}]}`;
  const found = parseReviewFindings(log) ?? [];
  assert.equal(found.length, 1);
  assert.equal(found[0]?.file, 'y.ts');
});

test('a half-written finding is dropped rather than rendered', () => {
  // In a PR body a partial finding reads exactly as authoritative as a complete
  // one, so there is no safe way to render it.
  const found = parseReviewFindings(
    '{"findings": [{"severity":"duplication","file":"a.ts"},{"severity":"size","file":"b.ts","what":"w","why":"y"}]}',
  ) ?? [];
  assert.deepEqual(found.map((f) => f.file), ['b.ts']);
});

test('an invented severity is not passed through', () => {
  assert.deepEqual(
    parseReviewFindings('{"findings": [{"severity":"critical","file":"a.ts","what":"w","why":"y"}]}'),
    [],
  );
});

test('a log with no findings object means "did not answer", not "found none"', () => {
  // The distinction this codebase never blurs, and I broke it. Measured live:
  // opencode failed to resolve a model, printed an APIError, exited ZERO, and
  // the review reported "no structural findings" — a clean bill of health from a
  // pass that never ran. `run.ok` cannot catch that on its own; the absence of
  // an answer is the only evidence.
  assert.equal(parseReviewFindings('the model said nothing useful'), null);
  // An explicitly empty list is a real answer and stays one.
  assert.deepEqual(parseReviewFindings('{"findings": []}'), []);
});

test('a harness that exited zero without answering is not a clean review', async () => {
  const r = await repo();
  try {
    const result = await harnessReview({
      harness: fakeHarness({ ok: true, log: 'error: {"name":"APIError","message":"model not available"}' }),
      dir: r.dir,
      pkg: 'axios', fromVersion: '0.21.1', toVersion: '0.33.0', diff: '',
    });
    assert.equal(result.ok, false, 'exiting zero is not the same as answering');
    assert.match(result.reason ?? '', /no findings object/);
  } finally {
    r.cleanup();
  }
});

// ---------------------------------------------------------------------------
// What it asks for, and what it must not
// ---------------------------------------------------------------------------

test('the prompt excludes what the structured review already covers', () => {
  // Two passes reporting the same cast is not redundancy that makes the result
  // safer — it is one finding arriving twice, in a body where the reader's
  // attention is the scarce thing.
  const prompt = reviewPrompt({ pkg: 'axios', fromVersion: '0.21.1', toVersion: '0.33.0', diff: '' });
  assert.match(prompt, /Do NOT report those/);
  assert.match(prompt, /casts, `any`/);
});

test('the prompt asks only for what needs the repository', () => {
  const prompt = reviewPrompt({ pkg: 'axios', fromVersion: '0.21.1', toVersion: '0.33.0', diff: '' });
  for (const criterion of ['duplication', 'structural', 'boundary', 'size']) {
    assert.ok(prompt.includes(criterion), `${criterion} must be asked for`);
  }
  assert.match(prompt, /cannot change anything/);
  assert.match(prompt, /Report nothing you have not opened/);
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test('nothing found renders nothing, not an empty heading', () => {
  // An empty heading in a PR body reads as a verdict. This pass is advisory.
  assert.equal(renderReviewFindings([]), '');
});

test('structural findings are rendered before cosmetic ones', () => {
  const out = renderReviewFindings([
    { severity: 'size', file: 'b.ts', what: 'long', why: '' },
    { severity: 'structural', file: 'a.ts', what: 'leaked', why: '' },
  ]);
  assert.ok(out.indexOf('a.ts') < out.indexOf('b.ts'));
  assert.match(out, /nothing here was changed automatically/);
});

test('the harness’s own bookkeeping is not mistaken for an edit', async () => {
  // Measured on the first live run: opencode writes `.omo/run-continuation/…`
  // on every run whatever the permissions say, and the did-it-write check
  // counted that as an edit and threw away a review in which no source file had
  // changed at all. The read-only permission had worked perfectly.
  const r = await repo();
  try {
    const result = await harnessReview({
      harness: fakeHarness({
        log: FINDINGS,
        artifacts: ['.omo/'],
        onRun: (dir) => {
          mkdirSync(path.join(dir, '.omo', 'run-continuation'), { recursive: true });
          writeFileSync(path.join(dir, '.omo', 'run-continuation', 'ses_1.json'), '{}');
        },
      }),
      dir: r.dir,
      pkg: 'axios', fromVersion: '0.21.1', toVersion: '0.33.0', diff: '',
    });
    assert.equal(result.ok, true, result.reason ?? '');
    assert.equal(result.findings.length, 2);
  } finally {
    r.cleanup();
  }
});

test('declaring artifacts does not excuse writing source', async () => {
  // The exclusion is a narrow carve-out for a tool's own state, not an amnesty.
  // A harness that declares an artifact directory and then edits the repository
  // must still be refused, or the check is decorative.
  const r = await repo();
  try {
    const result = await harnessReview({
      harness: fakeHarness({
        log: FINDINGS,
        artifacts: ['.omo/'],
        onRun: (dir) => {
          mkdirSync(path.join(dir, '.omo'), { recursive: true });
          writeFileSync(path.join(dir, '.omo', 'ses.json'), '{}');
          writeFileSync(path.join(dir, 'a.ts'), 'export const a = 2;\n');
        },
      }),
      dir: r.dir,
      pkg: 'axios', fromVersion: '0.21.1', toVersion: '0.33.0', diff: '',
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.findings, []);
  } finally {
    r.cleanup();
  }
});
