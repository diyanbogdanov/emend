import test from 'node:test';
import assert from 'node:assert/strict';
import { clientFor } from '../src/registry.ts';
import { toPackageVersions } from '../src/python/pypi.ts';

test('PyPI is claimed by the Python client', () => {
  assert.equal(clientFor('PyPI')?.id, 'pypi');
  assert.equal(clientFor('npm')?.id, 'npm');
  assert.equal(clientFor('crates.io'), undefined);
});

test("PyPI's JSON shape maps onto the neutral one", () => {
  // `info.version` is PyPI's answer to npm's `latest` dist-tag: what a bare
  // `pip install` gets, which is not necessarily the highest version published.
  const mapped = toPackageVersions(
    {
      info: { version: '2.31.0' },
      releases: { '2.30.0': [], '2.31.0': [], '3.0.0rc1': [] },
    },
    'requests',
  );
  assert.equal(mapped.name, 'requests');
  assert.equal(mapped.latest, '2.31.0');
  assert.deepEqual(mapped.versions.sort(), ['2.30.0', '2.31.0', '3.0.0rc1']);
});

test('a missing info.version yields a null latest, and the version list survives', () => {
  // `resolveTargetVersion` falls back to the highest non-prerelease when latest
  // is null, and that fallback needs the full version list to work from.
  const mapped = toPackageVersions({ releases: { '1.0': [] } }, 'lonely');
  assert.equal(mapped.latest, null);
  assert.equal(mapped.name, 'lonely');
  assert.deepEqual(mapped.versions, ['1.0']);
});
