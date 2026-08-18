import test from 'node:test';
import assert from 'node:assert/strict';
import { clientFor, resolveTargetVersion, type PackageVersions } from '../src/registry.ts';

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
