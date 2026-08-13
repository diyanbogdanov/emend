import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { checkFires } from '../src/quality.ts';
import {
  measureCase,
  scoreCase,
  summarise,
  scanOptionsFor,
  BUILT_IN_CASES,
  OPENAI_CASE,
  type CaseOutcome,
  type EvalCase,
} from '../src/eval.ts';
import type { PackageFixResult } from '../src/fix.ts';

const zodCase: EvalCase = {
  id: 'zod-3-to-4',
  pkg: 'zod',
  toVersion: '4.4.3',
  repo: { kind: 'fixture', name: 'demo-repo' },
  minimalEdits: 2,
  mustResolve: [{ symbol: 'ZodError.errors', kind: 'absent', pattern: '\\.error\\.errors\\b' }],
};

/** The real corpus denominator, for the tests that are about the ceiling. */
const zodSixCase: EvalCase = { ...zodCase, minimalEdits: 6 };

const okCommand = { command: 'tsc --noEmit', ok: true, exitCode: 0, stdout: '', stderr: '' };

/**
 * A finished `fixPackage`, for the tests about what measuring one produces.
 *
 * `workspaceDir` is null by default because these tests are about the outcome's
 * shape, not about reading a tree — and a null workspace is itself one of the
 * states worth pinning.
 */
function fixResult(over: Partial<PackageFixResult> = {}): PackageFixResult {
  return {
    pkg: 'zod',
    fromVersion: '3.22.4',
    toVersion: '4.4.3',
    findings: [],
    plans: [],
    unplanned: [],
    verification: {
      outcome: 'verified',
      baseline: { typecheck: okCommand, test: okCommand },
      post: { typecheck: okCommand, test: okCommand },
      summary: 'verified',
    },
    diff: '',
    appliedEdits: 3,
    failedEdits: [],
    bump: null,
    workspaceDir: null,
    workspaceMode: null,
    harness: {
      id: 'opencode',
      ok: true,
      log: '',
      keptHunks: 3,
      revertedHunks: [
        {
          hunk: { file: 'src/schema.ts', start: 1, end: 2 },
          evidence: 'unrequested',
          reason: 'no diagnostic on the lines it changed',
        },
      ],
    },
    ...over,
  };
}

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

test('over-editing is reported as scope and never blocks clean', () => {
  // The review pass is *supposed* to edit. The repair's judgement was handed to
  // the reviewer, and the two commits after that made the review two swappable
  // skills and gave it room to act — so charging it for acting argues with the
  // design rather than measuring it.
  //
  // Measured, on the first live sweep of this scorer: react-query's review
  // changed `isLoading` to `isPending`, which is the exact behaviour
  // `REACT_QUERY_CASE` says "the read-only behaviour review exists to notice".
  // Nothing scored it and the edit count penalised it.
  //
  // So the ratio goes back to being what `RECHARTS_CASE` always called it — "a
  // signal about scope, not a precise measure, read alongside the deprecation and
  // escape columns rather than on its own". It is still computed and still
  // printed; it decides nothing.
  const score = scoreCase(zodCase, outcome({ editsApplied: 6 }));
  assert.equal(score.passed, true);
  assert.equal(score.editRatio, 3, 'the scope signal is still measured and still reported');
  assert.equal(score.clean, true, 'but volume alone is not a defect');
  assert.deepEqual(score.penalties, []);
});

test('what blocks clean is the migration failing, never the size of the diff', () => {
  // The whole of `clean`, stated once: every one of these is the migration not
  // doing its job or the harness not being able to tell. None is a count.
  const big = outcome({ editsApplied: 40 });
  assert.equal(scoreCase(zodCase, big).clean, true, 'volume alone: clean');

  const defects: Array<[string, Partial<CaseOutcome>]> = [
    ['a type escape', { typeEscapes: 1 }],
    ['a deprecation left in place', { deprecationGaps: 1 }],
    ['a symbol never resolved', { unresolved: ['ZodError.errors'] }],
    ['a check that could not run', { uncheckable: ['record — unreadable'] }],
    ['tests that never ran', { verdict: 'typecheck-only' }],
    ['a build that did not verify', { verdict: 'regression' }],
  ];
  for (const [label, over] of defects) {
    assert.equal(
      scoreCase(zodCase, outcome({ ...big, ...over })).clean,
      false,
      `${label} must block clean`,
    );
  }
});

test('a complete migration is not penalised for hunks that merged', () => {
  // The measurement artifact this scorer was rebuilt around. `editsApplied` counts diff hunks;
  // `minimalEdits` counts logical edits. Applying all six of zod's required
  // edits to the fixture by hand produces *four* hunks at `--unified=1`, because
  // the three deprecations sit on lines 11, 12 and 14 with unchanged context
  // between them. Six is unreachable, so the old under-edit penalty fired on the
  // correct answer — and the sweep recorded zod at "4 of 6" on all three runs.
  const score = scoreCase(zodSixCase, outcome({ editsApplied: 4 }));
  assert.equal(score.passed, true);
  assert.equal(score.clean, true, 'four hunks is what six required edits look like');
  assert.deepEqual(score.penalties, []);
});

test('under-editing is caught by what resolved, not by how few hunks landed', () => {
  // The first live sweep ranked qwen3-coder top at 0.4x: it fixed the two
  // compile errors and skipped all three deprecations. A scorer that only
  // punishes doing too much reads "did less" as "did better" and puts the least
  // complete migration at the head of the table — training for exactly the
  // failure #2 exists to catch.
  //
  // The count cannot see it: hunks are a lower bound on edits, so a low number
  // is equally consistent with a finished migration whose edits merged. What
  // that run actually left behind is three unresolved symbols, and that is the
  // thing worth scoring.
  const score = scoreCase(zodSixCase, outcome({
    editsApplied: 1,
    unresolved: ['ZodString.uuid', 'ZodString.email', 'ZodString.datetime'],
  }));
  assert.equal(score.passed, true, 'the build is green');
  assert.equal(score.clean, false, 'but three deprecations left in place is not a finished migration');
  assert.ok(score.penalties.some((p) => p.includes('ZodString.uuid')));
});

test('a completeness check that could not run never scores clean', () => {
  // The cardinal rule, turned on the benchmark's own completeness column.
  // "Could not check" is not "checked and clean", and the two are reported
  // separately because they are different claims.
  const score = scoreCase(zodSixCase, outcome({
    editsApplied: 4,
    uncheckable: ['record — src/schema.ts could not be read'],
  }));
  assert.equal(score.passed, true);
  assert.equal(score.clean, false, 'an unread file is not evidence of a finished migration');
  assert.ok(score.penalties.some((p) => p.includes('could not')));
});

test('the table never ranks a padder above a run whose edits merged', () => {
  // The sort inverts with the ratio. Ordering by `|ratio - 1|` was right while
  // the ratio could err in both directions; once a *correct* migration reads
  // below one — zod's six edits are four hunks — nearest-to-1.0 puts the run
  // that padded ahead of the run that did the job. Excess is the only half of
  // the ratio that is measurable, so it is the only half that orders.
  //
  // Both runs carry a type escape so their clean rates tie and the tiebreaker is
  // what is actually under test.
  const rows = summarise(
    [zodSixCase],
    [
      outcome({ model: 'merged', editsApplied: 3, typeEscapes: 1 }),
      outcome({ model: 'padder', editsApplied: 7, typeEscapes: 1 }),
    ],
  );
  assert.equal(rows[0]?.model, 'merged', 'a ratio below one is merged hunks, not skipped work');
});

test('unresolved symbols are totalled, because completeness is now the headline', () => {
  // The argument `totalEditsWithheld` and `totalHunksReverted` were both added
  // under: a signal absent from the table is invisible in the only place it
  // would ever be judged.
  const rows = summarise(
    [zodSixCase],
    [
      outcome({ model: 'finished', editsApplied: 4 }),
      outcome({ model: 'partial', editsApplied: 2, unresolved: ['ZodString.uuid', 'record'] }),
    ],
  );
  assert.equal(rows.find((r) => r.model === 'finished')?.totalUnresolved, 0);
  assert.equal(rows.find((r) => r.model === 'partial')?.totalUnresolved, 2);
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
  // Both models verify everything. One finishes the migration; the other leaves a
  // deprecation in its zod 3 form and still compiles, because deprecated code
  // compiles and its tests pass. Pass rate calls them identical, which is how a
  // worse model gets adopted.
  //
  // This distinguished them by edit count until the scorer stopped the count
  // deciding anything. The lesson is unchanged and the defect is now a real one:
  // what separates the two models is whether the migration was done.
  const rows = summarise(
    [zodCase],
    [
      outcome({ model: 'finished' }),
      outcome({ model: 'skipped', unresolved: ['ZodString.uuid'] }),
    ],
  );
  const finished = rows.find((r) => r.model === 'finished');
  const skipped = rows.find((r) => r.model === 'skipped');
  assert.equal(finished?.passRate, 1);
  assert.equal(skipped?.passRate, 1, 'both are green — that is the whole problem');
  assert.equal(finished?.cleanRate, 1);
  assert.equal(skipped?.cleanRate, 0);
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
      outcome({ model: 'noisy' }),
      outcome({ model: 'noisy' }),
      // The run that left `Cell` behind — the measured variance above, not a
      // difference in how much diff it produced.
      outcome({ model: 'noisy', unresolved: ['ZodError.errors'] }),
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

test('every built-in case declares what finishing it means', () => {
  // Guards the class, like the target test below. `mustResolve` is optional so a
  // third-party corpus can make no completeness claim, but this corpus makes one
  // for every case — otherwise a case added without checks scores clean on the
  // strength of nothing having been measured, which is the shape of the bug this
  // whole section is about.
  for (const c of BUILT_IN_CASES) {
    assert.ok(
      (c.mustResolve?.length ?? 0) > 0,
      `${c.id} must declare what a finished migration looks like`,
    );
  }
});

test('every declared check fires on the un-migrated fixture', async () => {
  // The invariant that makes the completeness column mean anything. A check that
  // does not match the *baseline* is vacuous: it reports `resolved` against a
  // migration that did nothing at all, and the column reads clean everywhere
  // while measuring nothing.
  //
  // That is exactly how `EvalCase.toVersion`, `SurfaceChange.symbolKind` and
  // `mustResolve` itself each failed — declared, plausible, and never once
  // executed against the case they were written for. This test is pure: it reads
  // `fixtures/`, and needs no install, no network and no model.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  for (const c of BUILT_IN_CASES) {
    if (c.repo.kind !== 'fixture') continue;
    const dir = path.join(root, 'fixtures', c.repo.name);
    const sources: string[] = [];
    for (const sub of ['src', 'test']) {
      const at = path.join(dir, sub);
      const entries = await readdir(at, { recursive: true, withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile() || !/\.[cm]?[jt]sx?$/.test(entry.name)) continue;
        sources.push(await readFile(path.join(entry.parentPath, entry.name), 'utf8'));
      }
    }
    assert.ok(sources.length > 0, `${c.id}: no fixture sources found at ${dir}`);

    for (const check of c.mustResolve ?? []) {
      assert.ok(
        sources.some((source) => checkFires(check, source)),
        `${c.id}: the check for \`${check.symbol}\` matches nothing in the un-migrated fixture, ` +
          `so it would report the migration finished before it started`,
      );
    }
  }
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

test('the engine that did the work is on the outcome, whoever measured it', async () => {
  // `scripts/capture-case.ts` assembled its own `CaseOutcome` for a while and
  // left these three fields off it, so a captured run credited its edits to
  // nobody while a sweep of the identical run credited them correctly. The
  // attribution is the reason `CaseOutcome` carries a harness at all — a model
  // and a model-plus-harness are different engines, and a table that cannot tell
  // them apart cannot be read. One measurement is how the two stay one answer.
  const outcome = await measureCase(zodCase, [], fixResult(), 'test/model');

  assert.equal(outcome.harness, 'opencode');
  assert.equal(outcome.harnessKept, 3);
  assert.equal(outcome.harnessReverted, 1);
  assert.equal(outcome.editsWithheld, 1, 'reverted hunks are what "withheld" means now');
});

test('a case that declares completeness and kept no workspace is unknown, never resolved', async () => {
  // The cardinal rule turned on the thing that measures. There is no tree left
  // to read, so the migration was not checked — and "not checked" scored as
  // "finished" is the claim this whole corpus exists to refuse.
  const outcome = await measureCase(zodCase, [], fixResult({ workspaceDir: null }), 'test/model');

  assert.equal(outcome.unresolved, undefined, 'nothing was found outstanding, because nothing was read');
  assert.deepEqual(outcome.uncheckable, ['ZodError.errors — no workspace was kept']);
  assert.ok(
    scoreCase(zodCase, outcome).penalties.some((p) => /could not check/.test(p)),
    'and it is said out loud rather than passing quietly',
  );
});
