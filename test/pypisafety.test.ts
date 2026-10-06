import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

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
const { extractZip, pypiClient } = await import('../src/python/pypi.ts');

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

// ---------------------------------------------------------------------------
// The wheel itself. The publisher of a package chooses its bytes, and the
// hosted App downloads two wheels per dependency on every scan — so size, the
// bytes on disk after inflating, and whether the file is the one PyPI indexed
// are all checked rather than trusted.
// ---------------------------------------------------------------------------

/** A zip of the given entries; `deflate` stores an entry compressed, as wheels do. */
function zipOf(entries: { name: string; data: Buffer; deflate?: boolean }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const body = e.deflate ? zlib.deflateRawSync(e.data) : e.data;
    const method = e.deflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(e.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);

    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, eocd]);
}

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

/** PyPI's version document and the wheel it points at, served from a stub. */
function servePyPI(
  pkg: string,
  wheel: Buffer,
  listed: { size: number; sha256: string },
): { calls: string[]; wheelUrl: string; restore: () => void } {
  const wheelUrl = `https://files.pythonhosted.org/packages/${pkg}-1.0-py3-none-any.whl`;
  const doc = {
    urls: [
      {
        filename: `${pkg}-1.0-py3-none-any.whl`,
        packagetype: 'bdist_wheel',
        url: wheelUrl,
        size: listed.size,
        digests: { sha256: listed.sha256 },
      },
    ],
  };
  const stub = stubFetch((url) =>
    url === wheelUrl ? new Response(new Uint8Array(wheel)) : new Response(JSON.stringify(doc)),
  );
  return { ...stub, wheelUrl };
}

const module = Buffer.from('def greet(name):\n    return name\n');
const wheel = zipOf([{ name: 'demo/__init__.py', data: module, deflate: true }]);

test('a wheel inside the limits whose digest matches is cached and returned', async () => {
  // The control: none of the checks below may cost the ordinary case.
  const { restore } = servePyPI('demo-ok', wheel, { size: wheel.length, sha256: sha256(wheel) });
  try {
    const dir = await pypiClient().fetch('demo-ok', '1.0');
    assert.equal(dir, path.join(cacheRoot, 'demo-ok', '1.0'));
    assert.deepEqual(await readFile(path.join(dir, 'demo', '__init__.py')), module);
  } finally {
    restore();
  }
});

test('a wheel PyPI lists as gigabytes is refused before it is downloaded', async () => {
  // PyPI computes the size on upload, so the publisher cannot understate it —
  // checked before the request, because downloading it is the cost.
  const { calls, wheelUrl, restore } = servePyPI('demo-huge', wheel, {
    size: 5 * 1024 ** 3,
    sha256: sha256(wheel),
  });
  try {
    await assert.rejects(() => pypiClient().fetch('demo-huge', '1.0'), /refusing .*MiB/);
    assert.equal(calls.includes(wheelUrl), false);
  } finally {
    restore();
  }
});

test('a wheel whose bytes are not the ones PyPI indexed is refused, and nothing is cached', async () => {
  // The cache is shared by every later scan, so a file that is not the one
  // PyPI recorded would be read as the package for as long as it stays there.
  const { restore } = servePyPI('demo-swapped', wheel, {
    size: wheel.length,
    sha256: sha256(Buffer.from('a different file')),
  });
  try {
    await assert.rejects(() => pypiClient().fetch('demo-swapped', '1.0'), /sha256/);
    assert.equal(existsSync(path.join(cacheRoot, 'demo-swapped')), false);
  } finally {
    restore();
  }
});

test('an entry that inflates past the extraction limit is refused', async () => {
  // A megabyte of zeros deflates to about a kilobyte. Without a limit on
  // what inflating may produce, a small wheel fills the disk of whatever
  // scans it.
  const bomb = zipOf([{ name: 'demo/zeros.py', data: Buffer.alloc(1024 * 1024), deflate: true }]);
  const dest = await mkdtemp(path.join(sandbox, 'bomb-'));
  await assert.rejects(() => extractZip(bomb, dest, 64 * 1024), /extraction limit/);
});

test('the extraction limit counts everything written, not each entry alone', async () => {
  // The non-recursive zip bomb points many entries at one compressed block,
  // so every entry is small and only their sum is not.
  const half = Buffer.alloc(40 * 1024);
  const many = zipOf([
    { name: 'demo/a.py', data: half, deflate: true },
    { name: 'demo/b.py', data: half, deflate: true },
  ]);
  const dest = await mkdtemp(path.join(sandbox, 'many-'));
  await assert.rejects(() => extractZip(many, dest, 64 * 1024), /extraction limit/);
});
