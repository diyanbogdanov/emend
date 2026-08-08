import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reviewPrompt,
  parseReviewFindings,
  renderReviewFindings,
  reviewRepository,
  type RepoReader,
} from '../src/reviewharness.ts';

const FINDINGS = `{"findings": [
  {"severity": "duplication", "file": "src/util/money.ts", "what": "minorToMajor duplicates centsToUnits", "why": "two roundings drift"},
  {"severity": "size", "file": "src/client.ts", "what": "now 1240 lines", "why": "no reader holds it"}
]}`;

function reader(files: Record<string, string>): RepoReader {
  return {
    list: async () => Object.keys(files),
    read: async (f) => files[f] ?? null,
  };
}

const REPO = { 'src/client.ts': 'export const a = 1;', 'src/util/money.ts': 'export const b = 2;' };
const INPUT = { pkg: 'axios', fromVersion: '0.21.1', toVersion: '0.33.0', diff: '' };

// ---------------------------------------------------------------------------
// Read-only by construction, not by permission
// ---------------------------------------------------------------------------

test('the model can read files it asks for', async () => {
  const seen: string[] = [];
  const result = await reviewRepository(
    async (messages) => {
      const last = messages[messages.length - 1]?.content ?? '';
      if (last.includes('export const b = 2')) return { ok: true, content: FINDINGS };
      seen.push('asked');
      return { ok: true, content: 'READ: src/util/money.ts' };
    },
    reader(REPO), INPUT,
  );
  assert.equal(result.ok, true, result.reason ?? '');
  assert.equal(result.findings.length, 2);
  assert.equal(seen.length, 1, 'one round of reading, then the answer');
});

test('a path the repository never offered is not read', async () => {
  // `list` is the allowlist, and it is the only place traversal could happen.
  // A model asking for something outside the checkout is told it does not exist
  // rather than handed the file.
  let delivered = '';
  await reviewRepository(
    async (messages) => {
      const last = messages[messages.length - 1]?.content ?? '';
      if (last.includes('not a file')) { delivered = last; return { ok: true, content: '{"findings": []}' }; }
      return { ok: true, content: 'READ: ../../.ssh/id_rsa' };
    },
    reader(REPO), INPUT,
  );
  assert.match(delivered, /not a file in this repository/);
  assert.ok(!delivered.includes('id_rsa\n```'), 'no contents were returned');
});

test('a review that never answers is not a clean review', async () => {
  // The bug the opencode run exposed, in the shape this loop can reach it:
  // rounds run out and no findings object arrives. That is "did not conclude",
  // never "found nothing".
  const result = await reviewRepository(
    async () => ({ ok: true, content: 'READ: src/client.ts' }),
    reader(REPO), INPUT,
  );
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /did not produce a findings object/);
  assert.deepEqual(result.findings, []);
});

test('a model error is reported, not swallowed as an empty result', async () => {
  const result = await reviewRepository(
    async () => ({ ok: false, content: '', error: 'model not available' }),
    reader(REPO), INPUT,
  );
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /model not available/);
});

test('the reading budget is bounded so a large repository cannot run away', async () => {
  const big = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [`src/f${i}.ts`, 'x'.repeat(20_000)]),
  );
  let rounds = 0;
  const result = await reviewRepository(
    async (messages) => {
      rounds++;
      const last = messages[messages.length - 1]?.content ?? '';
      if (last.includes('budget is spent')) return { ok: true, content: '{"findings": []}' };
      return { ok: true, content: Object.keys(big).slice(0, 6).map((f) => `READ: ${f}`).join('\n') };
    },
    reader(big), INPUT,
  );
  assert.ok(rounds <= 4, `bounded rounds, got ${rounds}`);
  assert.ok(result.ok || (result.reason ?? '').length > 0);
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



test('an answer given without opening a file is pushed back once', async () => {
  // Measured live: GLM 5.2 concluded "no structural findings" on its first
  // reply, having read nothing — while judging a repository whose bait was a
  // helper duplicating one in the diff and feature logic in a shared module.
  // Neither is visible from a list of paths.
  const replies = ['{"findings": []}', 'READ: src/util/money.ts', FINDINGS];
  let i = 0;
  const result = await reviewRepository(async () => ({ ok: true, content: replies[i++] ?? '' }), reader(REPO), INPUT);
  assert.equal(result.ok, true, result.reason ?? '');
  assert.equal(result.findings.length, 2, 'the answer after reading is the one taken');
  assert.equal(i, 3, 'pushed back once, then read, then answered');
});

test('the push-back happens once, not until the rounds run out', async () => {
  // Refusing repeatedly turns a thin review into no review, which is worse.
  let calls = 0;
  const result = await reviewRepository(
    async () => { calls++; return { ok: true, content: '{"findings": []}' }; },
    reader(REPO), INPUT,
  );
  assert.equal(result.ok, true);
  assert.equal(calls, 2, 'one push-back, then the answer is accepted');
});
