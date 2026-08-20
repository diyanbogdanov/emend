import test from 'node:test';
import assert from 'node:assert/strict';
import { pep440Scheme } from '../src/pep440.ts';
import { schemeFor, semverFloor } from '../src/versions.ts';

const pep = pep440Scheme();

test('PyPI is claimed by PEP 440, not by the semver floor', () => {
  // The trap `versions.ts` documents: semver claims every ecosystem, so a PyPI
  // scheme registered after it would never be reached.
  assert.equal(schemeFor('PyPI').id, 'pep440');
  assert.equal(schemeFor('npm').id, 'semver');
});

test('a post-release outranks the release it follows', () => {
  // Semver cannot see `.post1` at all — it splits on `-` and finds nothing, so
  // `1.0.post1` and `1.0` compare equal. That is the whole reason this exists.
  assert.ok(pep.compare('1.0.post1', '1.0') > 0);
  assert.ok(semverFloor().compare('1.0.post1', '1.0') === 0);
});

test('a dev release sorts below everything it precedes', () => {
  assert.ok(pep.compare('1.0.dev1', '1.0') < 0);
  assert.ok(pep.compare('1.0.dev1', '1.0a1') < 0);
  assert.ok(pep.compare('1.0.dev2', '1.0.dev1') > 0);
});

test('prereleases order a < b < rc < release', () => {
  assert.ok(pep.compare('1.0a1', '1.0b1') < 0);
  assert.ok(pep.compare('1.0b1', '1.0rc1') < 0);
  assert.ok(pep.compare('1.0rc1', '1.0') < 0);
});

test('an epoch outranks everything without one', () => {
  // `1!1.0` beats `2.0`: the epoch exists precisely to let a project restart its
  // version numbering, so height below the epoch is irrelevant.
  assert.ok(pep.compare('1!1.0', '2.0') > 0);
  assert.ok(pep.compare('1!1.0', '0!9.9') > 0);
});

test('release segments compare numerically, not lexically, and pad with zeroes', () => {
  assert.ok(pep.compare('1.10', '1.9') > 0);
  assert.equal(pep.compare('1.0', '1.0.0'), 0);
  assert.equal(pep.compare('1.0', '1'), 0);
});

test('a local version outranks the same release without one', () => {
  assert.ok(pep.compare('1.0+local', '1.0') > 0);
});

test('only dev and pre-releases count as prereleases; post does not', () => {
  // `isPrerelease` decides whether a version can be an upgrade target. A
  // `.postN` release is a normal release with a packaging fix and is a perfectly
  // good target; `.devN` and `rcN` are not.
  assert.equal(pep.isPrerelease('1.0.dev1'), true);
  assert.equal(pep.isPrerelease('1.0a1'), true);
  assert.equal(pep.isPrerelease('1.0rc1'), true);
  assert.equal(pep.isPrerelease('1.0.post1'), false);
  assert.equal(pep.isPrerelease('1.0'), false);
});

test('an unparseable version is ordered last rather than crashing', () => {
  // PyPI carries genuinely malformed versions from before PEP 440 was enforced.
  // Throwing here would abort a scan over one bad package; treating it as
  // lowest keeps it from ever being proposed as an upgrade target.
  assert.ok(pep.compare('not-a-version', '1.0') < 0);
});
