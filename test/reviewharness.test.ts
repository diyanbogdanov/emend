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
  reviewSession,
  assistantText,
  parseContractFindings,
} from '../src/reviewharness.ts';
import type { Harness } from '../src/harness.ts';

const run = promisify(execFile);

const FINDINGS = `{"findings": [
  {"severity": "duplication", "file": "src/util/money.ts", "what": "minorToMajor duplicates centsToUnits", "why": "two roundings drift"},
  {"severity": "boundary", "file": "src/shared/http.ts", "what": "charge logic in a general-purpose GET", "why": "couples every caller"}
]}`;

async function repo(): Promise<{ dir: string; cleanup: () => void }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-review-'));
  await run('git', ['init', '-b', 'main', dir]);
  await run('git', ['-C', dir, 'config', 'user.email', 't@e.com']);
  await run('git', ['-C', dir, 'config', 'user.name', 'T']);
  writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
  await run('git', ['-C', dir, 'add', '-A']);
  await run('git', ['-C', dir, 'commit', '-m', 'base']);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function fakeHarness(over: Partial<{ log: string; ok: boolean; reason: string; onRun: (dir: string) => void }> = {}): Harness {
  return {
    id: 'fake',
    available: async () => (over.reason ? { ok: false, reason: over.reason } : { ok: true }),
    run: async (dir) => {
      over.onRun?.(dir);
      return { ok: over.ok ?? true, log: over.log ?? '' };
    },
  };
}

const INPUT = { pkg: 'axios', fromVersion: '0.21.1', toVersion: '0.33.0', diff: '' };

// ---------------------------------------------------------------------------
// A reviewer that rewrites what it judges has stopped being one
// ---------------------------------------------------------------------------

test('findings come back from a session that changed nothing', async () => {
  const r = await repo();
  try {
    const result = await reviewSession({ harness: fakeHarness({ log: FINDINGS }), dir: r.dir, ...INPUT });
    assert.equal(result.ok, true, result.reason ?? '');
    assert.equal(result.findings.length, 2);
  } finally {
    r.cleanup();
  }
});

test('a session that edited the workspace has its findings discarded', async () => {
  const r = await repo();
  try {
    const result = await reviewSession({
      harness: fakeHarness({ log: FINDINGS, onRun: (dir) => writeFileSync(path.join(dir, 'a.ts'), 'export const a = 2;\n') }),
      dir: r.dir, ...INPUT,
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.findings, []);
    assert.match(result.reason ?? '', /modified the workspace/);
  } finally {
    r.cleanup();
  }
});

test('the harness’s own bookkeeping is not mistaken for an edit', async () => {
  // opencode writes .omo/run-continuation/ses_*.json on every run whatever the
  // permissions say. Counting that as an edit discarded a review in which no
  // source file had changed at all — the read-only intent had held perfectly.
  const r = await repo();
  try {
    const result = await reviewSession({
      harness: fakeHarness({
        log: FINDINGS,
        onRun: (dir) => {
          mkdirSync(path.join(dir, '.omo', 'run-continuation'), { recursive: true });
          writeFileSync(path.join(dir, '.omo', 'run-continuation', 'ses_1.json'), '{}');
        },
      }),
      dir: r.dir, ...INPUT,
    });
    assert.equal(result.ok, true, result.reason ?? '');
  } finally {
    r.cleanup();
  }
});

test('a session that exited zero without answering is not a clean review', async () => {
  // Measured: opencode failed to resolve a model, printed an APIError and exited
  // ZERO. Reporting "no structural findings" there is a clean bill of health
  // from a review that never ran.
  const r = await repo();
  try {
    const result = await reviewSession({
      harness: fakeHarness({ log: 'error: {"name":"APIError","message":"model not available"}' }),
      dir: r.dir, ...INPUT,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /no findings object/);
  } finally {
    r.cleanup();
  }
});

test('an unavailable harness says so rather than reporting nothing found', async () => {
  const r = await repo();
  try {
    const result = await reviewSession({
      harness: fakeHarness({ reason: 'opencode is not installed' }),
      dir: r.dir, ...INPUT,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /not installed/);
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

test('an invented severity is not passed through, and not read as silence either', () => {
  // This asserted `[]` and that was the wrong answer to a real question. A model
  // that rated one finding "critical" did find something; reporting no findings
  // claims the opposite of what it said. Nothing is passed through either way —
  // the difference is whether the caller hears "clean" or "I could not read the
  // answer", and only the second is true.
  assert.equal(
    parseReviewFindings('{"findings": [{"severity":"critical","file":"a.ts","what":"w","why":"y"}]}'),
    null,
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
  assert.match(prompt, /a separate pass already covers those/);
  assert.match(prompt, /casts, `any`/);
});

test('the prompt asks only for what needs the repository', () => {
  const prompt = reviewPrompt({ pkg: 'axios', fromVersion: '0.21.1', toVersion: '0.33.0', diff: '' });
  for (const criterion of ['duplication', 'structural', 'boundary', 'size']) {
    assert.ok(prompt.includes(criterion), `${criterion} must be asked for`);
  }
  assert.match(prompt, /change nothing/i, 'the review must not edit what it judges');
  // The instruction that decides whether it explores at all. Measured: without a
  // concrete "go and read" the model answers from the diff and finds nothing.
  assert.match(prompt, /Read the files under the source directory before answering/);
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





// ---------------------------------------------------------------------------
// Reading opencode's event stream
// ---------------------------------------------------------------------------

test('the reply is pulled out of the event stream, where it is escaped', () => {
  // `--format json` emits newline-delimited events and puts the reply inside
  // `part.text`, JSON-escaped. So a findings object arrives on the wire as
  // `{\"findings\": []}` and a scan of the raw log for `{"findings"` never
  // matches — which is why a review that answered correctly was reported as
  // having produced no output.
  const log = [
    '{"type":"step_start","part":{"type":"step-start"}}',
    '{"type":"text","part":{"type":"text","text":"{\\"findings\\": [{\\"severity\\":\\"duplication\\",\\"file\\":\\"a.ts\\",\\"what\\":\\"w\\",\\"why\\":\\"y\\"}]}"}}',
    '{"type":"step_finish","part":{"type":"step-finish","reason":"stop"}}',
  ].join('\n');
  const found = parseReviewFindings(assistantText(log));
  assert.equal(found?.length, 1);
  assert.equal(found?.[0]?.file, 'a.ts');
});

test('several text events are joined, not just the first', () => {
  const log = [
    '{"type":"text","part":{"type":"text","text":"Here is what I found."}}',
    '{"type":"text","part":{"type":"text","text":"{\\"findings\\": []}"}}',
  ].join('\n');
  assert.deepEqual(parseReviewFindings(assistantText(log)), []);
});

test('a log that is not an event stream is passed through untouched', () => {
  // Two things depend on this: a harness that prints plainly, and an error line
  // that must still reach the caller as "did not answer" rather than be
  // swallowed into an empty string.
  assert.equal(assistantText('{"findings": []}'), '{"findings": []}');
  const err = 'error: {"name":"APIError","data":{"message":"model not available"}}';
  assert.equal(assistantText(err), err);
  assert.equal(parseReviewFindings(assistantText(err)), null);
});

// ---------------------------------------------------------------------------
// The contract review answers a different question, in a different shape
// ---------------------------------------------------------------------------

test('a contract review finding survives being parsed', () => {
  // `contractReviewPrompt` asks for `kind`/`path`/`detail`, and the migration
  // parser accepts only `severity`/`file`/`what`/`why` — so a review that named
  // the exact failure it was built to catch came back as an empty array, and the
  // caller printed "no structural findings". A review that cannot report is
  // worse than no review, because it reports the opposite.
  const said =
    'I read the consuming code.\n' +
    '{"findings": [{"kind": "scope", "path": "src/contacts.ts", ' +
    '"detail": "the audience filter is gone, so this returns every contact"}]}';
  const findings = parseContractFindings(said);
  assert.equal(findings?.length, 1);
  assert.equal(findings?.[0]?.kind, 'scope');
  assert.equal(findings?.[0]?.path, 'src/contacts.ts');
});

test('an answer whose every finding was discarded is not a clean answer', () => {
  // The general form of the bug above. Filtering entries that fail validation
  // turns "I did not understand the answer" into "there was nothing to report",
  // and the two are opposite claims. If the model said something and none of it
  // survived, the honest result is that no answer was obtained.
  const said = '{"findings": [{"severity": "invented", "file": "a.ts", "what": "x", "why": "y"}]}';
  assert.equal(parseReviewFindings(said), null);
  // An array that was genuinely empty still means what it says.
  assert.deepEqual(parseReviewFindings('{"findings": []}'), []);
});

test('every severity the prompt asks for is one the parser accepts', () => {
  // The bug this file kept producing, caught once instead of twice. The prompt
  // named `complexity` and `atomicity`; the parser knew four severities and
  // dropped both — so the two findings the review rated most interesting were
  // the two it could not report. Reading the accepted set out of the prompt
  // itself means the next person to add a category cannot half-add it.
  const prompt = reviewPrompt({ pkg: 'x', fromVersion: '1', toVersion: '2', diff: '' });
  const asked = [...prompt.matchAll(/"severity": ([^,\n]+)/g)]
    .flatMap((m) => [...(m[1] ?? '').matchAll(/"([a-z]+)"/g)].map((s) => s[1]))
    .filter((s): s is string => s !== undefined);
  assert.ok(asked.length >= 4, `expected the prompt to name its severities, saw ${asked.length}`);

  for (const severity of asked) {
    const said = `{"findings": [{"severity": "${severity}", "file": "a.ts", "what": "x", "why": "y"}]}`;
    assert.equal(
      parseReviewFindings(said)?.length,
      1,
      `the prompt asks for "${severity}" and the parser discards it`,
    );
  }
});
