import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreCase,
  summarise,
  scanOptionsFor,
  BUILT_IN_CASES,
  OPENAI_CASE,
  type CaseOutcome,
  type EvalCase,
} from '../src/eval.ts';

const zodCase: EvalCase = {
  id: 'zod-3-to-4',
  pkg: 'zod',
  toVersion: '4.4.3',
  repo: { kind: 'fixture', name: 'demo-repo' },
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

test('under-editing is penalised too, and never rewarded', () => {
  // The first live sweep ranked qwen3-coder top at 0.4x: it fixed the two
  // compile errors and skipped all three deprecations. A scorer that only
  // punishes doing too much reads "did less" as "did better" and puts the least
  // complete migration at the head of the table — training for exactly the
  // failure #2 exists to catch.
  const score = scoreCase(zodCase, outcome({ editsApplied: 1 }));
  assert.equal(score.passed, true, 'the build is green');
  assert.equal(score.clean, false, 'but half the required edits is not a finished migration');
  assert.ok(score.penalties.some((p) => p.includes('incomplete')));
});

test('the table ranks by distance from the minimum, not by fewest edits', () => {
  const rows = summarise(
    [zodCase],
    [
      outcome({ model: 'complete', editsApplied: 2 }),
      outcome({ model: 'skipped-work', editsApplied: 1 }),
      outcome({ model: 'padder', editsApplied: 5 }),
    ],
  );
  assert.equal(rows[0]?.model, 'complete', 'the migration that did the job comes first');
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

test('repeated runs of one case count as one case and many runs', () => {
  // Two live runs of the same recharts migration under the same model gave
  // opposite results: one removed `Cell` and rendered `$NaN`, the other narrowed
  // correctly and left `Cell` behind. A single run is not a measurement, so the
  // harness repeats — and a row that said "3/1 cases" would be nonsense while a
  // row that said "1 case, 67% clean" is the actual finding.
  const rows = summarise(
    [zodCase],
    [
      outcome({ model: 'noisy', editsApplied: 2 }),
      outcome({ model: 'noisy', editsApplied: 2 }),
      outcome({ model: 'noisy', editsApplied: 6 }),
    ],
  );
  const noisy = rows.find((r) => r.model === 'noisy');
  assert.equal(noisy?.casesRun, 1, 'one distinct case, however many times it ran');
  assert.equal(noisy?.runs, 3);
  assert.ok(
    noisy!.cleanRate > 0.66 && noisy!.cleanRate < 0.67,
    `two clean of three runs; got ${noisy?.cleanRate}`,
  );
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

test('a run whose engine produced nothing is inconclusive, not a failure', () => {
  // Measured, not hypothetical. A sweep once printed "25% pass" over nine
  // consecutive runs where the harness reported `changed nothing` — the engine
  // never attempted the work, and the table read as a quality result. That is
  // the cardinal rule turned on the benchmark: Emend counts unreadable call
  // sites rather than scoring them clean, and a run whose engine never ran is
  // the same claim, made by the thing that measures.
  const evalCase = { id: 'c', pkg: 'p', toVersion: '2.0.0', repo: { kind: 'local' as const, dir: '/x' }, minimalEdits: 2 };
  const base = {
    caseId: 'c', model: 'm', verdict: 'regression' as const, editsApplied: 0,
    editsWithheld: 0, errorsBefore: 2, errorsAfter: 2, typeEscapes: 0,
    deprecationGaps: 0, durationMs: 1,
  };

  const dead = scoreCase(evalCase, { ...base, inconclusive: 'opencode changed nothing' });
  assert.equal(dead.inconclusive, true);
  assert.match(dead.penalties[0] ?? '', /INCONCLUSIVE/);

  const real = scoreCase(evalCase, base);
  assert.equal(real.inconclusive, false);
  assert.match(real.penalties[0] ?? '', /did not verify/);
});

test('rates are computed over runs that happened, with the rest counted beside them', () => {
  // Three runs, one real pass and two dead engines. Averaging the dead ones in
  // reports 33%; excluding them reports 100% with a visible "2 inconclusive".
  // Those are different claims and only the second is true.
  const evalCase = { id: 'c', pkg: 'p', toVersion: '2.0.0', repo: { kind: 'local' as const, dir: '/x' }, minimalEdits: 2 };
  const base = {
    caseId: 'c', model: 'm', editsApplied: 2, editsWithheld: 0,
    errorsBefore: 2, errorsAfter: 0, typeEscapes: 0, deprecationGaps: 0, durationMs: 1,
  };
  const [row] = summarise([evalCase], [
    { ...base, verdict: 'verified' as const },
    { ...base, verdict: 'regression' as const, editsApplied: 0, errorsAfter: 2, inconclusive: 'changed nothing' },
    { ...base, verdict: 'regression' as const, editsApplied: 0, errorsAfter: 2, inconclusive: 'unavailable' },
  ]);
  assert.equal(row?.runs, 3);
  assert.equal(row?.inconclusive, 2);
  assert.equal(row?.passRate, 1);
});

test('a case migrates to the version it names, not to whatever npm published today', () => {
  // `EvalCase.toVersion` was declared, set on all four cases, and read by
  // nothing. `runCase` scanned, and a scan resolves the `latest` dist-tag — so
  // `openai-3.3.0-to-4.104.0` was migrating 3.3.0 to 7.4.0, three major versions
  // past the migration its own id names.
  //
  // That is what openai's steady 1.5x was. `minimalEdits: 4` was counted by
  // performing the 3 -> 4 migration; the run performed 3 -> 7. The denominator
  // was never stale — the subject moved out from under it.
  //
  // A benchmark whose subject changes with the calendar cannot measure a model:
  // two sweeps a month apart would share a name and not a migration, and the
  // difference between them would be read as the model getting worse.
  const options = scanOptionsFor(OPENAI_CASE);

  assert.deepEqual(options.only, ['openai']);
  assert.equal(
    options.targets?.['openai'],
    OPENAI_CASE.toVersion,
    'the declared target has to reach the scan, or it is a comment',
  );
});

test('every built-in case pins its target, so the corpus is reproducible', () => {
  // Guards the class rather than the instance. A case added without a target
  // silently reintroduces the drift, and it would show up as that case
  // over-editing rather than as a corpus defect.
  for (const c of BUILT_IN_CASES) {
    assert.equal(
      scanOptionsFor(c).targets?.[c.pkg],
      c.toVersion,
      `${c.id} must migrate to the version its id names`,
    );
  }
});
