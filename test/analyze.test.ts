import test from 'node:test';
import assert from 'node:assert/strict';
import { isUpToDate } from '../src/analyze.ts';

/**
 * `isUpToDate` is Stage 1's gate: it decides whether a dependency is even
 * worth fetching a surface and diffing for, before any of that runs. Getting
 * it wrong for an ecosystem is silent in the exact way this codebase exists
 * to avoid — a package skipped as up-to-date is reported the same as a
 * package that was actually analysed and found clean, and nothing downstream
 * can tell the two apart.
 */

test('a PyPI package at 1.0 with 1.0.post1 published is not up-to-date', () => {
  // The bug this guards: `1.0.post1` is a PEP 440 post-release, strictly newer
  // than `1.0`. The npm-only (semver) comparator sees no `-` in either side and
  // calls them equal, which used to make `analyze.ts` skip this package as
  // up-to-date and never analyse it — a Python repository on `1.0` would never
  // learn `1.0.post1` existed.
  assert.equal(isUpToDate('PyPI', '1.0', '1.0.post1'), false);
});

test('a PyPI package already on the target version is up-to-date', () => {
  assert.equal(isUpToDate('PyPI', '1.0', '1.0'), true);
});

test('an npm package behaves as before: semver still gates it', () => {
  assert.equal(isUpToDate('npm', '1.0.0', '1.0.0'), true);
  assert.equal(isUpToDate('npm', '1.0.0', '2.0.0'), false);
  // A prerelease is not an upgrade over the release it precedes.
  assert.equal(isUpToDate('npm', '1.0.0', '1.0.0-rc.1'), true);
});
