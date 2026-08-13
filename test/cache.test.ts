import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listCache, pruneCache } from '../src/registry.ts';

/**
 * A cache root laid out the way `fetchPackageDir` writes one:
 * `<root>/<pkg with / as +>/<version>/package/...`
 */
function cacheWith(entries: Record<string, string[]>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'emend-cache-'));
  for (const [pkg, versions] of Object.entries(entries)) {
    for (const version of versions) {
      const dir = path.join(root, pkg.replace('/', '+'), version, 'package');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkg, version }));
      writeFileSync(path.join(dir, 'index.d.ts'), 'export declare const x: number;\n');
    }
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const ago = (days: number): Date => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

test('the cache is listed by package, with every version it holds', async () => {
  // 13 GB accumulated locally across 2,640 packages with no way to see inside it
  // from the CLI. A total alone does not say what to delete; the per-package
  // breakdown is the whole point.
  const { root, cleanup } = cacheWith({
    '@1password/sdk': ['0.4.0', '0.5.0'],
    zod: ['4.4.3'],
  });
  try {
    const rows = await listCache(root);
    assert.equal(rows.length, 2);

    const sdk = rows.find((r) => r.pkg === '@1password/sdk');
    assert.ok(sdk, 'a scoped name is decoded back from its on-disk form');
    assert.deepEqual(sdk?.versions, ['0.4.0', '0.5.0']);
    assert.ok((sdk?.bytes ?? 0) > 0, 'size is what makes the list actionable');
    assert.ok(rows.every((r) => r.lastUsed), 'and age is what makes it prunable');
  } finally {
    cleanup();
  }
});

test('the cache is keyed by package, never by repository', async () => {
  // Stated as a test because it is the constraint that shapes the whole feature:
  // one `zod/4.4.3` entry serves every repository that ever resolved it, so
  // "prune the cache for this repo" cannot mean anything. Nothing in a cache
  // entry names a repository, and if that ever changes this test should fail.
  const { root, cleanup } = cacheWith({ zod: ['4.4.3'] });
  try {
    const [entry] = await listCache(root);
    assert.deepEqual(Object.keys(entry ?? {}).sort(), ['bytes', 'lastUsed', 'pkg', 'versions']);
  } finally {
    cleanup();
  }
});

test('pruning one package leaves the rest of the cache alone', async () => {
  const { root, cleanup } = cacheWith({ zod: ['4.4.3'], recharts: ['3.10.1'] });
  try {
    const removed = await pruneCache({ pkg: 'zod' }, root);
    assert.equal(removed.packages, 1);
    assert.ok(removed.bytes > 0);
    assert.equal(existsSync(path.join(root, 'zod')), false);
    assert.equal(existsSync(path.join(root, 'recharts')), true, 'the neighbour survives');
  } finally {
    cleanup();
  }
});

test('pruning a package that is not cached removes nothing and says so', async () => {
  // Same reason the store reports its counts: a typo must not read as a clear.
  const { root, cleanup } = cacheWith({ zod: ['4.4.3'] });
  try {
    const removed = await pruneCache({ pkg: 'zodd' }, root);
    assert.equal(removed.packages, 0);
    assert.equal(removed.bytes, 0);
    assert.equal(existsSync(path.join(root, 'zod')), true);
  } finally {
    cleanup();
  }
});

test('pruning by age keeps what is still in use', async () => {
  // The useful default on a 13 GB cache: a type surface pulled today is worth
  // keeping, one from a sweep two months ago is not. Age is per package, taken
  // from the most recently touched version so a package still in use is never
  // dropped because one old version of it is stale.
  const { root, cleanup } = cacheWith({ stale: ['1.0.0'], fresh: ['2.0.0'] });
  try {
    const old = ago(90);
    utimesSync(path.join(root, 'stale', '1.0.0'), old, old);
    utimesSync(path.join(root, 'stale'), old, old);

    const removed = await pruneCache({ olderThanDays: 30 }, root);
    assert.equal(removed.packages, 1);
    assert.equal(existsSync(path.join(root, 'stale')), false);
    assert.equal(existsSync(path.join(root, 'fresh')), true);
  } finally {
    cleanup();
  }
});

test('clearing the whole cache empties it without removing the root', async () => {
  // The root is recreated on the next fetch either way, but leaving it in place
  // keeps a configured EMEND_CACHE pointing somewhere that exists.
  const { root, cleanup } = cacheWith({ zod: ['4.4.3'], recharts: ['3.10.1'] });
  try {
    const removed = await pruneCache({ all: true }, root);
    assert.equal(removed.packages, 2);
    assert.equal(existsSync(root), true);
    assert.deepEqual(await listCache(root), []);
  } finally {
    cleanup();
  }
});

test('a prune with no target refuses rather than guessing', async () => {
  // `--all` deletes gigabytes. An empty options object reaching this by mistake
  // must not be read as "delete everything", which is the one interpretation
  // that cannot be undone.
  const { root, cleanup } = cacheWith({ zod: ['4.4.3'] });
  try {
    await assert.rejects(() => pruneCache({}, root), /nothing to prune|specify/i);
    assert.equal(existsSync(path.join(root, 'zod')), true);
  } finally {
    cleanup();
  }
});

test('the download staging area is not a package, and a prune leaves it alone', async () => {
  // Measured on a real 2,641-entry cache: `listCache` reported one more package
  // than the directory held. `fetchPackageDir` stages downloads in
  // `<root>/.staging/...` before renaming them into place, so the scratch
  // directory was being counted as a package named `.staging`.
  //
  // Deleting it is the worse half: a prune running while a scan is fetching
  // would pull the tarball out from under it. npm forbids a package name
  // starting with a dot, so skipping dot-entries is exact rather than a guess.
  const { root, cleanup } = cacheWith({ zod: ['4.4.3'] });
  try {
    mkdirSync(path.join(root, '.staging', 'emend-123-in-flight'), { recursive: true });
    writeFileSync(path.join(root, '.staging', 'emend-123-in-flight', 'pkg.tgz'), 'partial');

    const rows = await listCache(root);
    assert.deepEqual(rows.map((r) => r.pkg), ['zod'], 'staging is not a package');

    const removed = await pruneCache({ all: true }, root);
    assert.equal(removed.packages, 1, 'and is not counted as one when clearing');
    assert.equal(existsSync(path.join(root, '.staging')), true, 'an in-flight fetch survives');
  } finally {
    cleanup();
  }
});

test('a cache root that does not exist lists as empty rather than throwing', async () => {
  assert.deepEqual(await listCache(path.join(tmpdir(), 'emend-cache-does-not-exist-xyz')), []);
});
