import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions } from '../src/registry.ts';

test('a leading v does not make every major version zero', () => {
  // `parseInt('v1')` is NaN, which fell through to 0 — so `v2.0.0` and `v1.0.0`
  // compared equal. Docker tags are written `v18`, so this outlives Go.
  assert.ok(compareVersions('v2.0.0', 'v1.0.0') > 0);
  assert.ok(compareVersions('v1.6.0', 'v1.9.1') < 0);
  assert.equal(compareVersions('v1.6.0', '1.6.0'), 0);
  assert.ok(compareVersions('v18', 'v22') < 0);
});

test('prerelease sorts below the release it precedes', () => {
  assert.ok(compareVersions('1.0.0-rc.1', '1.0.0') < 0);
  assert.ok(compareVersions('1.0.0', '1.0.0-rc.1') > 0);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-rc.1'), 0);
});
