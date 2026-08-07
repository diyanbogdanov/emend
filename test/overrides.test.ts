import test from 'node:test';
import assert from 'node:assert/strict';
import { planOverride, reintroduced, type FixedRecord } from '../src/remediate.ts';

// ---------------------------------------------------------------------------
// Rung three: forcing a version a parent did not ask for
// ---------------------------------------------------------------------------

test('an override is written for the package, at the version that clears it', () => {
  const manifest = JSON.stringify({ name: 'app', dependencies: { express: '^4.17.1' } }, null, 2);
  const plan = planOverride(manifest, 'qs', '6.14.2');
  assert.notEqual(plan, null);
  const updated = JSON.parse(plan?.replace ?? '{}');
  assert.equal(updated.overrides?.qs, '6.14.2');
});

test('an existing overrides block is added to, never replaced', () => {
  // Somebody put those there on purpose. Overwriting the block would silently
  // undo a decision this tool knows nothing about.
  const manifest = JSON.stringify(
    { name: 'app', overrides: { semver: '7.5.4' }, dependencies: {} },
    null,
    2,
  );
  const updated = JSON.parse(planOverride(manifest, 'qs', '6.14.2')?.replace ?? '{}');
  assert.equal(updated.overrides.semver, '7.5.4');
  assert.equal(updated.overrides.qs, '6.14.2');
});

test('an override already pinning that package is left alone', () => {
  // Already decided. Rewriting it would be this tool arguing with its own
  // previous run, or with a human.
  const manifest = JSON.stringify({ name: 'app', overrides: { qs: '6.14.2' } }, null, 2);
  assert.equal(planOverride(manifest, 'qs', '6.14.2'), null);
});

test('an unreadable manifest yields no plan rather than a rewritten one', () => {
  assert.equal(planOverride('not json', 'qs', '6.14.2'), null);
});

test('the edit matches the file exactly, so apply can refuse a stale one', () => {
  // The same contract every other repair here uses: `find` must match what is on
  // disk, or the edit is rejected rather than applied to something else.
  const manifest = JSON.stringify({ name: 'app' }, null, 2);
  const plan = planOverride(manifest, 'qs', '6.14.2');
  assert.equal(plan?.find, manifest);
  assert.equal(plan?.file, 'package.json');
});

// ---------------------------------------------------------------------------
// The regression guard
// ---------------------------------------------------------------------------

const FIXED: FixedRecord[] = [{ pkg: 'lodash', fixedAt: '4.18.0', advisories: ['GHSA-a'] }];

test('a package dropping back below what fixed it is a reintroduction', () => {
  // The shape this guards: a revert, a bad merge, a lockfile regenerated from a
  // stale branch. It looks like a new finding, and treating it as one loses the
  // fact that this was already dealt with once.
  const back = reintroduced(FIXED, new Map([['lodash', '4.17.15']]));
  assert.equal(back.length, 1);
  assert.equal(back[0]?.pkg, 'lodash');
  assert.equal(back[0]?.was, '4.18.0');
  assert.equal(back[0]?.now, '4.17.15');
});

test('a package still at or above the fix is not flagged', () => {
  assert.deepEqual(reintroduced(FIXED, new Map([['lodash', '4.18.0']])), []);
  assert.deepEqual(reintroduced(FIXED, new Map([['lodash', '4.19.1']])), []);
});

test('a package no longer installed is not a reintroduction', () => {
  // Removing the dependency is a fix, not a regression.
  assert.deepEqual(reintroduced(FIXED, new Map()), []);
});

test('nothing recorded as fixed means nothing to regress', () => {
  assert.deepEqual(reintroduced([], new Map([['lodash', '1.0.0']])), []);
});
