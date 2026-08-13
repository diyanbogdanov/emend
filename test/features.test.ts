import test from 'node:test';
import assert from 'node:assert/strict';
import { featureFindings, newExports, FEATURES_SHOWN } from '../src/features.ts';
import type { SurfaceChange } from '../src/types.ts';

function added(path: string): SurfaceChange {
  return {
    path,
    kind: 'added',
    severity: 'feature',
    confidence: 'high',
    before: null,
    after: `${path}(): void`,
  };
}

const REACT_QUERY = {
  pkg: '@tanstack/react-query',
  fromVersion: '4.36.1',
  toVersion: '5.101.4',
};

test('a new top-level export of a package you depend on is reported', () => {
  // The half of the problem statement that npm answered barely at all. `diffSurfaces` has
  // always emitted these — `kind: 'added'`, `severity: 'feature'` — and
  // `consumerImpacting` has always dropped them, correctly for its own purpose:
  // its output feeds call-site matching, and a symbol absent from your code has
  // no call sites. Nothing else ever looked.
  const [finding] = featureFindings([
    { ...REACT_QUERY, added: [added('useSuspenseQuery')] },
  ]);

  assert.ok(finding, 'a package that gained an export produces a finding');
  assert.equal(finding.change.severity, 'feature');
  assert.match(finding.change.guidance ?? '', /useSuspenseQuery/);
  // No call site, and deliberately: the claim is that this is available, not
  // that anything uses it. Somewhere to point would say the opposite.
  assert.deepEqual(finding.sites, []);
});

test('an implementation detail that became visible is not a feature', () => {
  // `z.core.util.assertEqual` is not a capability anybody was waiting for. The
  // depth of the path is the whole filter — cheap, and it does not require
  // inventing a relevance score Emend has no evidence for.
  const findings = featureFindings([
    {
      pkg: 'zod',
      fromVersion: '3.22.4',
      toVersion: '4.4.3',
      added: [added('core.util.assertEqual'), added('ZodString.trimStart')],
    },
  ]);

  assert.deepEqual(findings, []);
});

test('a wall of new exports is capped, and says how many it is not showing', () => {
  // The freshness precedent, for the reason freshness states: these are
  // unbounded, every repository has some, and pouring them in beside proven
  // findings inverts the signal-to-noise ratio that makes a scan worth reading.
  const many = Array.from({ length: FEATURES_SHOWN + 7 }, (_, i) => added(`brandNew${i}`));
  const [finding] = featureFindings([{ ...REACT_QUERY, added: many }]);

  assert.ok(finding);
  const shown = (finding.change.guidance ?? '').match(/brandNew\d+/g) ?? [];
  assert.equal(shown.length, FEATURES_SHOWN, 'shows exactly the cap');
  assert.match(finding.change.guidance ?? '', /7 more/, 'and counts the rest rather than hiding them');
});

test('a package that gained nothing produces no finding at all', () => {
  assert.deepEqual(featureFindings([{ ...REACT_QUERY, added: [] }]), []);
});

test('only additions count — a removal in the same list is not a feature', () => {
  // `added` is handed the diff's changes; it must not trust the caller to have
  // pre-filtered them, because the one caller that forgets turns a breaking
  // change into a suggestion.
  const removal: SurfaceChange = {
    path: 'useQueries',
    kind: 'removed',
    severity: 'breaking',
    confidence: 'high',
    before: 'useQueries(): void',
    after: null,
  };
  assert.deepEqual(featureFindings([{ ...REACT_QUERY, added: [removal] }]), []);
});

test('two packages get one finding each, not one merged finding', () => {
  const findings = featureFindings([
    { ...REACT_QUERY, added: [added('useSuspenseQuery')] },
    { pkg: 'zod', fromVersion: '3.22.4', toVersion: '4.4.3', added: [added('stringbool')] },
  ]);

  assert.equal(findings.length, 2);
  assert.deepEqual(
    findings.map((f) => f.pkg).sort(),
    ['@tanstack/react-query', 'zod'],
  );
  // Distinct ids, so storing both does not collapse them into one row.
  assert.notEqual(findings[0]?.id, findings[1]?.id);
});

test('the id survives a rescan and changes when the upgrade does', () => {
  const one = featureFindings([{ ...REACT_QUERY, added: [added('useSuspenseQuery')] }])[0];
  const again = featureFindings([{ ...REACT_QUERY, added: [added('useSuspenseQuery')] }])[0];
  const laterTarget = featureFindings([
    { ...REACT_QUERY, toVersion: '5.200.0', added: [added('useSuspenseQuery')] },
  ])[0];

  assert.equal(one?.id, again?.id, 'a rescan must not produce a second row for the same fact');
  assert.notEqual(one?.id, laterTarget?.id, 'a different upgrade is a different fact');
});

test('narrowing for memory drops the signatures but not the filtering', () => {
  // Every analysed package's changes stay live for the whole scan. An addition
  // carries the new signature, and signatures are most of a surface's memory —
  // `analyze.ts` keeps its surfaces `withoutSignatures` for exactly this
  // reason. Narrowing early must not become the only filter, though: it is a
  // memory decision, and `featureFindings` still has to defend itself.
  const narrowed = newExports([
    added('useSuspenseQuery'),
    added('core.util.assertEqual'),
    { path: 'useQueries', kind: 'removed', severity: 'breaking', confidence: 'high',
      before: 'useQueries(): void', after: null },
  ]);

  assert.deepEqual(narrowed.map((c) => c.path), ['useSuspenseQuery']);
  assert.equal(narrowed[0]?.after, null, 'the signature text is not retained');
  // And the finding still reads correctly off the narrowed list.
  const [finding] = featureFindings([{ ...REACT_QUERY, added: narrowed }]);
  assert.match(finding?.change.guidance ?? '', /useSuspenseQuery/);
});

test('a new type is not a feature; a new function is', () => {
  // Measured, on the first real `--features` run against react-query 4 -> 5:
  //
  //   adds AnyDataTag, AnyUseBaseQueryOptions, AnyUseInfiniteQueryOptions,
  //   AnyUseMutationOptions, AnyUseQueryOptions and 80 more
  //
  // Every one of those is a type-level helper for someone else's generics, and
  // alphabetical order put the least interesting ones first. The capability
  // that actually shipped in v5 — `useSuspenseQuery` — was somewhere in the 80.
  //
  // This is the alert fatigue the design set out to avoid, arrived at anyway.
  // The fix is structural, not a relevance score: a value is something you can
  // call, a type is something you could already have written yourself.
  const findings = featureFindings([
    {
      ...REACT_QUERY,
      added: [
        { ...added('AnyUseQueryOptions'), symbolKind: 'type' },
        { ...added('UseSuspenseQueryOptions'), symbolKind: 'interface' },
        { ...added('useSuspenseQuery'), symbolKind: 'function' },
        { ...added('QueryClient'), symbolKind: 'class' },
      ],
    },
  ]);

  const guidance = findings[0]?.change.guidance ?? '';
  assert.match(guidance, /useSuspenseQuery/);
  assert.match(guidance, /QueryClient/);
  assert.doesNotMatch(guidance, /AnyUseQueryOptions/);
  assert.doesNotMatch(guidance, /UseSuspenseQueryOptions/);
});

test('an addition whose kind was never recorded is kept rather than guessed at', () => {
  // Older stored scans, and any surface extractor that could not classify a
  // declaration. Dropping them would be the cardinal rule inverted: "not known
  // to be a type" is not "known to be a type".
  const [finding] = featureFindings([
    { ...REACT_QUERY, added: [added('somethingUnclassified')] },
  ]);
  assert.match(finding?.change.guidance ?? '', /somethingUnclassified/);
});
