import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreCase, summarise, type CaseOutcome, type EvalCase } from '../src/eval.ts';

const zodCase: EvalCase = {
  id: 'zod-3-to-4',
  pkg: 'zod',
  toVersion: '4.4.3',
  repo: { kind: 'demo' },
  minimalEdits: 2,
  mustResolve: ['ZodError.errors', 'record'],
};

function outcome(over: Partial<CaseOutcome> = {}): CaseOutcome {
  return {
    caseId: 'zod-3-to-4',
    model: 'test/model',
    verdict: 'verified',
    editsApplied: 2,
    editsWithheld: 0,
    errorsBefore: 3,
    errorsAfter: 0,
    typeEscapes: 0,
    deprecationGaps: 0,
    durationMs: 1000,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// scoreCase — a green build is not the same as a good migration
// ---------------------------------------------------------------------------

test('a verified migration at the minimal edit count scores clean', () => {
  const score = scoreCase(zodCase, outcome());
  assert.equal(score.passed, true);
  assert.equal(score.clean, true);
  assert.deepEqual(score.penalties, []);
});

test('over-editing is penalised even though the build is green', () => {
  // The measured failure this whole harness exists to make visible: two models
  // produced six edits where two were required, rewriting deprecation call sites
  // nobody asked about. Every check passed, because the extra edits were valid
  // TypeScript. A scoreboard that only reports pass/fail cannot see it, and what
  // the harness cannot see, nobody optimises.
  const score = scoreCase(zodCase, outcome({ editsApplied: 6 }));
  assert.equal(score.passed, true, 'it did verify — that much is true');
  assert.equal(score.clean, false, 'but three times the necessary churn is not a clean result');
  assert.equal(score.editRatio, 3);
  assert.ok(score.penalties.some((p) => p.includes('edit')));
});

test('buying a green build with `any` is penalised', () => {
  // PR #1 measured this directly: one model reached verified with ten type
  // escapes and another with zero. Both are "verified".
  const score = scoreCase(zodCase, outcome({ typeEscapes: 4 }));
  assert.equal(score.passed, true);
  assert.equal(score.clean, false);
  assert.ok(score.penalties.some((p) => p.includes('type escape')));
});

test('a migration that left its deprecations in place is not clean', () => {
  // The recharts case: reported `Cell` as deprecated, titled the commit
  // "migrate `Cell`", removed no use of it, and passed every check.
  const score = scoreCase(zodCase, outcome({ deprecationGaps: 1 }));
  assert.equal(score.passed, true);
  assert.equal(score.clean, false);
  assert.ok(score.penalties.some((p) => p.includes('deprecat')));
});

test('a failed run still records how far it got', () => {
  // Byam reports at three granularities because build-level alone is too coarse:
  // its best configuration repaired 27% of builds while fixing 78% of the
  // individual errors in the builds that stayed red. A run that went 14 -> 2 and
  // one that went 14 -> 14 are both "failed" and are not the same result.
  const partial = scoreCase(zodCase, outcome({ verdict: 'regression', errorsBefore: 14, errorsAfter: 2 }));
  const stuck = scoreCase(zodCase, outcome({ verdict: 'regression', errorsBefore: 14, errorsAfter: 14 }));
  assert.equal(partial.passed, false);
  assert.equal(stuck.passed, false);
  assert.ok(
    partial.errorReduction > stuck.errorReduction,
    'progress must be visible even when the build is still red',
  );
  assert.equal(stuck.errorReduction, 0);
});

test('an unverified run is never counted as passing', () => {
  // Honesty rule 3: a verification that did not run is `unverified`, never
  // `passing`. A benchmark that scored it as a pass would launder exactly the
  // claim the product refuses to make.
  assert.equal(scoreCase(zodCase, outcome({ verdict: 'unverified' })).passed, false);
  assert.equal(scoreCase(zodCase, outcome({ verdict: 'pre-existing-failure' })).passed, false);
});

test('typecheck-only counts as passing but never as clean', () => {
  // It is a real result — the type contract holds — but the tests did not run,
  // so calling it equivalent to a full pass would overstate the evidence.
  const score = scoreCase(zodCase, outcome({ verdict: 'typecheck-only' }));
  assert.equal(score.passed, true);
  assert.equal(score.clean, false);
  assert.ok(score.penalties.some((p) => p.includes('tests did not run')));
});

// ---------------------------------------------------------------------------
// summarise — comparing models is the point
// ---------------------------------------------------------------------------

test('models are compared on clean rate, not just pass rate', () => {
  // Both models verify everything. One does it minimally; the other pads every
  // migration. Pass rate calls them identical, which is how a worse model gets
  // adopted.
  const rows = summarise(
    [zodCase],
    [
      outcome({ model: 'minimal', editsApplied: 2 }),
      outcome({ model: 'padder', editsApplied: 6 }),
    ],
  );
  const minimal = rows.find((r) => r.model === 'minimal');
  const padder = rows.find((r) => r.model === 'padder');
  assert.equal(minimal?.passRate, 1);
  assert.equal(padder?.passRate, 1);
  assert.equal(minimal?.cleanRate, 1);
  assert.equal(padder?.cleanRate, 0);
});

test('withheld edits are reported, because they are how the gate is judged', () => {
  // A model that proposes six edits and applies two after the gate withholds
  // four scores the same edit ratio as one that proposed two. Those are very
  // different models, and without this column the gate's own effect is invisible
  // — which is the claim it exists to support.
  const rows = summarise(
    [zodCase],
    [
      outcome({ model: 'restrained', editsApplied: 2, editsWithheld: 0 }),
      outcome({ model: 'gated', editsApplied: 2, editsWithheld: 4 }),
    ],
  );
  assert.equal(rows.find((r) => r.model === 'restrained')?.totalEditsWithheld, 0);
  assert.equal(rows.find((r) => r.model === 'gated')?.totalEditsWithheld, 4);
});

test('a model that was never run on a case is not silently scored as failing', () => {
  // Otherwise a cheap partial run makes a model look worse than one that was
  // given the full corpus, and the comparison is meaningless.
  const cases: EvalCase[] = [zodCase, { ...zodCase, id: 'other' }];
  const rows = summarise(cases, [outcome({ model: 'partial' })]);
  const row = rows.find((r) => r.model === 'partial');
  assert.equal(row?.casesRun, 1);
  assert.equal(row?.casesTotal, 2);
  assert.equal(row?.passRate, 1, 'scored over what it actually ran');
});
