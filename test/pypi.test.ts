import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clientFor } from '../src/registry.ts';
import { extractZip, toPackageVersions } from '../src/python/pypi.ts';

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

// ---------------------------------------------------------------------------
// extractZip — a wheel's entries are never a safe relative path by
// themselves; nothing here reuses `tar`'s own zip-slip protection, so
// `extractZip` has to check for it itself. Neither `readCentralDirectory` nor
// `readZipEntry` reads or verifies a CRC32, so the entries built below leave
// it zeroed — matching what a real wheel writer emits is not the point of
// this fixture.
// ---------------------------------------------------------------------------

/** A minimal single-entry, stored-method (uncompressed) zip buffer. */
function buildZip(entryName: string, content: string): Buffer {
  const nameBuf = Buffer.from(entryName, 'utf8');
  const dataBuf = Buffer.from(content, 'utf8');

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // local file header signature
  local.writeUInt16LE(20, 4); // version needed to extract
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(0, 8); // method: stored
  local.writeUInt32LE(dataBuf.length, 18); // compressed size
  local.writeUInt32LE(dataBuf.length, 22); // uncompressed size
  local.writeUInt16LE(nameBuf.length, 26); // file name length
  const localEntry = Buffer.concat([local, nameBuf, dataBuf]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); // central directory signature
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 10); // method: stored
  central.writeUInt32LE(dataBuf.length, 20); // compressed size
  central.writeUInt32LE(dataBuf.length, 24); // uncompressed size
  central.writeUInt16LE(nameBuf.length, 28); // file name length
  central.writeUInt32LE(0, 42); // local header offset
  const centralEntry = Buffer.concat([central, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end-of-central-directory signature
  eocd.writeUInt16LE(1, 8); // entries on this disk
  eocd.writeUInt16LE(1, 10); // total entries
  eocd.writeUInt32LE(centralEntry.length, 12); // central directory size
  eocd.writeUInt32LE(localEntry.length, 16); // central directory offset

  return Buffer.concat([localEntry, centralEntry, eocd]);
}

test('a well-behaved entry extracts to the expected path with its content intact', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'emend-zip-'));
  try {
    const zip = buildZip('requests/__init__.py', 'print("hi")\n');
    await extractZip(zip, root);
    const written = await readFile(path.join(root, 'requests', '__init__.py'), 'utf8');
    assert.equal(written, 'print("hi")\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a zip-slip entry is rejected, and nothing is written outside destDir', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'emend-zipslip-'));
  try {
    // The destination extraction directory, nested a few levels down — the
    // same shape `fetchWheelDirUncached` extracts into
    // (`CACHE_ROOT/<pkg>/<version>`).
    const destDir = path.join(root, 'dest', 'requests', '2.31.0');
    const outsideMarker = path.join(root, 'PWNED.txt');
    const evil = buildZip('../../../PWNED.txt', 'zip-slip payload');

    await assert.rejects(
      () => extractZip(evil, destDir),
      /escapes its extraction directory/,
    );
    await assert.rejects(() => readFile(outsideMarker, 'utf8'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
