import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// A lockfile is written by whoever owns the repository being scanned, and the
// hosted App scans repositories it has no reason to trust. Every name and
// version below is therefore attacker-controlled input, and `fetch` turns both
// into a cache path and a PyPI URL on an ordinary `emend scan`.
//
// CACHE_ROOT is read from EMEND_CACHE when registry.ts loads, and static imports
// are hoisted above every statement — so the cache is pointed at a throwaway
// directory first and the module is imported after. Without that, a test that
// got past a check it was meant to hit would write into the developer's real
// ~/.emend/cache.
const sandbox = await mkdtemp(path.join(tmpdir(), 'emend-pypi-'));
const cacheRoot = path.join(sandbox, 'cache');
process.env.EMEND_CACHE = cacheRoot;
const { pypiClient } = await import('../src/python/pypi.ts');

test.after(() => rm(sandbox, { recursive: true, force: true }));

/** Replaces `fetch`, recording every URL asked for. */
function stubFetch(route: (url: string) => Response): { calls: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    return route(url);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const unreachable = () => new Response('the request should never have been made', { status: 500 });

test('a lockfile version that walks out of the cache is refused before any request', async () => {
  // `#` ends the URL's path, so PyPI answers for idna 2.10 while path.join
  // collapses the same string to a directory outside the cache — the wheel
  // was downloaded and unpacked there.
  const { calls, restore } = stubFetch(unreachable);
  try {
    await assert.rejects(
      () => pypiClient().fetch('idna', '2.10/json#/../../../../ESCAPED'),
      /refusing/,
    );
    assert.deepEqual(calls, []);
    assert.equal(existsSync(path.join(sandbox, 'ESCAPED')), false);
  } finally {
    restore();
  }
});

test('a lockfile version naming an existing directory is not taken for a cached package', async () => {
  // The cache-hit check returns any directory that exists, so a version that
  // points at one hands it to the surface extractor as though it were the
  // package — and the hosted App writes what it extracted into a pull request
  // on the attacker's own repository.
  const victim = path.join(sandbox, 'victim');
  await mkdir(victim, { recursive: true });
  await writeFile(path.join(victim, 'settings.py'), 'TOKEN = "not yours"\n');
  const version = path.relative(path.join(cacheRoot, 'idna'), victim);

  const { calls, restore } = stubFetch(unreachable);
  try {
    await assert.rejects(() => pypiClient().fetch('idna', version), /refusing/);
    assert.deepEqual(calls, []);
  } finally {
    restore();
  }
});

test('a package name that rewrites the URL is refused, so it cannot fill another package’s cache entry', async () => {
  // Fetches evil's metadata, then lands at CACHE_ROOT/requests/2.31.0 —
  // inside the cache, so no containment check would notice, and every later
  // scan that shares the cache diffs `requests` against attacker files.
  const { calls, restore } = stubFetch(unreachable);
  try {
    await assert.rejects(
      () => pypiClient().fetch('evil/json#/../../requests', '2.31.0'),
      /refusing/,
    );
    await assert.rejects(() => pypiClient().versions('evil/json#/../../requests'), /refusing/);
    assert.deepEqual(calls, []);
  } finally {
    restore();
  }
});

test('names and versions real projects publish still reach PyPI', async () => {
  // The control for the three above: a check strict enough to refuse a real
  // package skips it, and a skipped package is a scan that silently covers
  // less. Each of these is a spelling PyPI actually serves.
  const { calls, restore } = stubFetch(() => new Response('{}', { status: 404 }));
  try {
    const coordinates: [string, string][] = [
      ['Django', '5.0.1'],
      ['zope.interface', '6.1'],
      ['typing_extensions', '4.9.0'],
      ['ruamel.yaml', '0.18.5'],
      ['pywin32', '1!306'],
      ['certifi', '2024.2.2.post1'],
      ['numpy', '2.0.0rc1'],
      ['torch', '2.2.0+cpu'],
      ['black', '24.1.0.dev3'],
    ];
    for (const [name, version] of coordinates) {
      await assert.rejects(() => pypiClient().fetch(name, version), /PyPI 404/);
    }
    await assert.rejects(() => pypiClient().versions('Django'), /PyPI 404/);
    assert.equal(calls.length, coordinates.length + 1);
  } finally {
    restore();
  }
});
