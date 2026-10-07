import test from 'node:test';
import assert from 'node:assert/strict';
import { clientFor, resolveRange, resolveTargetVersion, type PackageVersions } from '../src/registry.ts';

test('npm is claimed; other ecosystems are not', () => {
  assert.equal(clientFor('npm')?.id, 'npm');
  assert.equal(clientFor('crates.io'), undefined);
});

test('the latest tag wins when it names a version that was published', () => {
  // `resolveTargetVersion` reads the neutral shape now. `Packument` carries
  // `dist-tags` and `dist.tarball`; a crates.io client satisfying an interface
  // demanding those would have to fabricate them.
  const pack: PackageVersions = { name: 'serde', versions: ['1.0.0', '1.0.1'], latest: '1.0.1' };
  assert.equal(resolveTargetVersion(pack), '1.0.1');
});

test('a latest tag naming an unpublished version falls back to the highest stable', () => {
  // The `pack.versions?.[latest]` guard in the original: a dist-tag can point
  // at a version that was unpublished, and returning it would propose an
  // upgrade target that cannot be installed.
  const pack: PackageVersions = { name: 'serde', versions: ['1.0.0', '1.0.1'], latest: '9.9.9' };
  assert.equal(resolveTargetVersion(pack), '1.0.1');
});

test('with no latest tag, prereleases are skipped rather than winning on height', () => {
  // Deliberately not "highest version": a prerelease sorts above the release it
  // precedes, and proposing `2.0.0-rc.1` as an upgrade target is not what a
  // bare install would give you.
  const pack: PackageVersions = { name: 'serde', versions: ['1.0.0', '2.0.0-rc.1'], latest: null };
  assert.equal(resolveTargetVersion(pack), '1.0.0');
});

// ---------------------------------------------------------------------------
// resolveRange — places a package's *type dependencies* on disk
// (typescript/typedeps.ts), so the version it picks is the version npm is
// asked to fetch. A pick that was never published fails that fetch, and the
// package's declarations then resolve to nothing.
// ---------------------------------------------------------------------------

const typesNode: PackageVersions = {
  name: '@types/node',
  versions: ['18.19.3', '18.20.1', '20.0.0', '20.11.5', '20.12.0-beta.1', '22.0.0'],
  latest: '22.0.0',
};

test('a caret range resolves to the highest release it allows, never a prerelease', () => {
  assert.equal(resolveRange(typesNode, '^20.0.0'), '20.11.5');
});

test('a tilde range stays inside its minor', () => {
  assert.equal(resolveRange(typesNode, '~18.19.0'), '18.19.3');
});

test('a caret on a 0.x version holds the minor, as semver does', () => {
  const zero: PackageVersions = { name: 'z', versions: ['0.2.1', '0.2.5', '0.3.0'], latest: '0.3.0' };
  assert.equal(resolveRange(zero, '^0.2.1'), '0.2.5');
});

test('an exact pin resolves to itself only when it was published', () => {
  // The check this refactor rewrote (an object-key lookup on the packument
  // became `versions.includes`). A pin naming an unpublished version must not
  // be handed to npm as though it existed — `^5.7.0` read naively as 5.7.0,
  // which never shipped, is the failure the module doc warns about.
  assert.equal(resolveRange(typesNode, '20.11.5'), '20.11.5');
  assert.equal(resolveRange(typesNode, '20.11.4'), '22.0.0');
});

test('a wildcard, an empty range and "latest" all mean latest', () => {
  for (const range of ['*', '', 'latest', 'x']) assert.equal(resolveRange(typesNode, range), '22.0.0');
});

test('a package that has published only prereleases resolves to nothing', () => {
  const pre: PackageVersions = { name: 'p', versions: ['1.0.0-rc.1'], latest: '1.0.0-rc.1' };
  assert.equal(resolveRange(pre, '^1.0.0'), null);
});
