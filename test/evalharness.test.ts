import test from 'node:test';
import assert from 'node:assert/strict';
import { summarise, renderSummary, type CaseOutcome, type EvalCase } from '../src/eval.ts';

const CASE: EvalCase = {
  id: 'zod',
  pkg: 'zod',
  toVersion: '4.0.0',
  repo: { kind: 'fixture', name: 'demo' },
  minimalEdits: 2,
};

function outcome(over: Partial<CaseOutcome> = {}): CaseOutcome {
  return {
    caseId: 'zod',
    model: 'z-ai/glm-5.2',
    verdict: 'verified',
    editsApplied: 2,
    editsWithheld: 0,
    errorsBefore: 4,
    errorsAfter: 0,
    typeEscapes: 0,
    deprecationGaps: 0,
    durationMs: 1000,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

test('a harness run is a different engine, and gets its own row', () => {
  // The condition §8 puts on adopting a harness: it swaps the editing engine
  // itself, and folding its runs into the model's own row makes every subsequent
  // result unattributable. Two runs of `glm-5.2` that produced different work
  // for different reasons must not average into one number.
  const rows = summarise(
    [CASE],
    [
      outcome({ verdict: 'verified' }),
      outcome({ verdict: 'regression', harness: 'opencode' }),
    ],
  );
  assert.equal(rows.length, 2);
  const plain = rows.find((r) => !r.harness);
  const escalated = rows.find((r) => r.harness === 'opencode');
  assert.equal(plain?.passRate, 1);
  assert.equal(escalated?.passRate, 0);
});

test('runs of the same engine still aggregate, so repeats show variance', () => {
  const rows = summarise(
    [CASE],
    [
      outcome({ harness: 'opencode', verdict: 'verified' }),
      outcome({ harness: 'opencode', verdict: 'regression' }),
    ],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.runs, 2);
  assert.equal(rows[0]?.passRate, 0.5);
});

test('the engine is named in the rendered table, not left to be inferred', () => {
  const table = renderSummary(
    summarise([CASE], [outcome(), outcome({ harness: 'opencode' })]),
  );
  assert.match(table, /opencode/);
});

// ---------------------------------------------------------------------------
// What the harness contributed
// ---------------------------------------------------------------------------

test('hunks the gate reverted are totalled, because that is the gate being judged', () => {
  // The same reason `totalEditsWithheld` exists for structured edits. A harness
  // that wrote nine hunks and kept two scores exactly like one that wrote two,
  // and the gate's effect — the entire condition of adoption — is invisible in
  // the only place it would ever be measured.
  const rows = summarise(
    [CASE],
    [
      outcome({ harness: 'opencode', harnessKept: 2, harnessReverted: 3 }),
      outcome({ harness: 'opencode', harnessKept: 1, harnessReverted: 1 }),
    ],
  );
  assert.equal(rows[0]?.totalHunksReverted, 4);
  assert.equal(rows[0]?.totalHunksKept, 3);
});

test('a sweep with no harness reports no hunk totals rather than zeroes that mean nothing', () => {
  const rows = summarise([CASE], [outcome()]);
  assert.equal(rows[0]?.harness, undefined);
  assert.equal(rows[0]?.totalHunksReverted, 0);
});
