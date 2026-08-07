import test from 'node:test';
import assert from 'node:assert/strict';
import { freshnessFindings, inHeadline } from '../src/freshness.ts';
import type { PackageReport } from '../src/types.ts';

function analysed(over: Partial<PackageReport> = {}): PackageReport {
  return {
    pkg: 'lodash',
    status: 'analyzed',
    fromVersion: '4.17.15',
    toVersion: '4.17.21',
    findings: [],
    unlocatedBreaking: 0,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// What freshness is, and is not
// ---------------------------------------------------------------------------

test('a package behind its latest, with nothing that would break, is a freshness finding', () => {
  // The gap the scan currently reports as silence. "No findings" is true and
  // reads as "nothing to do", when in fact there is a free upgrade sitting
  // there that Emend has already proved is safe for this repository.
  const found = freshnessFindings([analysed()]);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.pkg, 'lodash');
  assert.equal(found[0]?.change.severity, 'freshness');
  assert.equal(found[0]?.fromVersion, '4.17.15');
  assert.equal(found[0]?.toVersion, '4.17.21');
});

test('a package with real findings is not also reported as merely behind', () => {
  // It is already in the report, with evidence. Listing it twice under a weaker
  // heading makes the stronger one look like one of several equal observations.
  const withBreak = analysed({
    findings: [
      {
        id: 'x',
        detector: 'npm-surface',
        pkg: 'lodash',
        fromVersion: '4.17.15',
        toVersion: '4.17.21',
        change: { path: 'a', kind: 'removed', severity: 'breaking', confidence: 'high', before: 'a', after: null },
        sites: [],
        confidence: 'high',
      },
    ],
  });
  assert.deepEqual(freshnessFindings([withBreak]), []);
});

test('a package already at its latest is not behind anything', () => {
  assert.deepEqual(freshnessFindings([analysed({ fromVersion: '4.17.21', toVersion: '4.17.21' })]), []);
});

test('a package that could not be analysed is not called fresh', () => {
  // The distinction the whole product turns on. Unanalysable means Emend does
  // not know whether the upgrade is safe, and a freshness finding asserts that
  // it is.
  assert.deepEqual(
    freshnessFindings([analysed({ status: 'unanalyzable', findings: [] })]),
    [],
  );
});

test('breaking changes this repository does not call are the point, not a disqualifier', () => {
  // Excluding these was the first rule tried, and running it showed why that was
  // wrong: zod 4.4.0 to 4.4.3 — a *patch* upgrade — carries fifteen breaking
  // surface changes this repository never calls, so the strict rule made the
  // detector fire essentially never.
  //
  // The honest claim is "nothing you call changed", not "nothing changed", and
  // saying how many were skipped past is stronger than staying silent. That is
  // what knowing the call sites is for.
  const found = freshnessFindings([analysed({ unlocatedBreaking: 15 })]);
  assert.equal(found.length, 1);
  assert.match(found[0]?.change.guidance ?? '', /15 breaking change\(s\).*none of which this repository calls/);
});

// ---------------------------------------------------------------------------
// Keeping the signal
// ---------------------------------------------------------------------------

test('freshness never reaches the headline count', () => {
  // Spec §6, and its acceptance criterion 4. These are unbounded — every
  // repository has some, and producing them requires no analysis — so counting
  // them beside proven findings inverts the signal-to-noise ratio that makes the
  // scan worth reading at all.
  assert.equal(inHeadline('breaking'), true);
  assert.equal(inHeadline('deprecation'), true);
  assert.equal(inHeadline('freshness'), false);
  assert.equal(inHeadline('lint'), false);
  assert.equal(inHeadline('vulnerability'), false);
  assert.equal(inHeadline('drift'), false);
});
