import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, schemeFor, semverFloor, type VersionScheme } from '../src/versions.ts';

test('a leading v does not make every major version zero', () => {
  // `parseInt('v1')` is NaN, which fell through to 0 — so `v2.0.0` and `v1.0.0`
  // compared equal. Docker tags are written `v18`, so this outlives Go.
  assert.ok(compareVersions('v2.0.0', 'v1.0.0') > 0);
  assert.ok(compareVersions('v1.6.0', 'v1.9.1') < 0);
  assert.equal(compareVersions('v1.6.0', '1.6.0'), 0);
  assert.ok(compareVersions('v18', 'v22') < 0);
});

test('prerelease sorts below the release it precedes', () => {
  // Untested until now: `fixedVersionFor` and `covers` in osv.ts compare an
  // installed version straight against an advisory's `fixed` bound, with no
  // prerelease filtering first — this ordering decides whether an installed
  // prerelease is read as already fixed or still vulnerable.
  assert.ok(compareVersions('1.0.0-rc.1', '1.0.0') < 0);
  assert.ok(compareVersions('1.0.0', '1.0.0-rc.1') > 0);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-rc.1'), 0);
});

test('an ecosystem with no registered scheme falls back to semver', () => {
  // Every ecosystem orders versions somehow; semver is the only scheme built.
  // The fallback keeps behaviour identical to before this seam existed.
  assert.equal(schemeFor('npm').id, 'semver');
  assert.equal(schemeFor('PyPI').id, 'semver');
});

test('a registered scheme is consulted ahead of the semver floor', () => {
  // PEP 440 says `1.0.post1` outranks `1.0`; semver says they are equal because
  // it cannot see the suffix. This is the whole point of the seam, so it is
  // tested through `schemeFor` itself rather than through a hand-built array —
  // a test that reconstructs the lookup proves `Array.find` works, not that
  // routing does, and would still pass with `schemeFor` completely broken.
  const pep440: VersionScheme = {
    id: 'pep440',
    handles: (eco) => eco === 'PyPI',
    compare: (a, b) => (a === '1.0.post1' && b === '1.0' ? 1 : 0),
    isPrerelease: () => false,
  };
  const found = schemeFor('PyPI', [pep440, semverFloor()]);
  assert.equal(found.id, 'pep440');
  assert.equal(found.compare('1.0.post1', '1.0'), 1);
});

test('semver still claims what no other scheme wants', () => {
  // Order matters: semver claims every ecosystem, so a scheme registered after
  // it could never be reached. Registering one before it must not break npm.
  const pep440: VersionScheme = {
    id: 'pep440',
    handles: (eco) => eco === 'PyPI',
    compare: () => 0,
    isPrerelease: () => false,
  };
  assert.equal(schemeFor('npm', [pep440, semverFloor()]).id, 'semver');
});

test('a registry with no floor says so rather than guessing', () => {
  // The `!` on a last-element fallback made this return undefined typed as a
  // VersionScheme, so the failure surfaced as a TypeError somewhere downstream
  // instead of naming the ecosystem nothing could order.
  assert.throws(() => schemeFor('crates.io', []), /no version scheme claims/);
});
