/**
 * PyPI registry client: version metadata, and wheel download + extraction.
 *
 * `versions()` reads PyPI's JSON API (`GET /pypi/<name>/json`), which is pure
 * metadata — no package code runs to answer it. `fetch()` downloads and
 * extracts a package version, and it prefers the wheel over the sdist for the
 * same reason `lockfile.ts` gives for parsing manifests instead of running
 * `npm install`: running a customer repository's dependency code during
 * analysis is arbitrary code execution, and that is the one thing Emend does
 * not do. An sdist can need its `setup.py` executed just to report its own
 * file list and metadata — that execution is precisely what the no-execution
 * rule forbids. A wheel is a zip of files the maintainer already built;
 * reading one open runs nothing. `pip` itself is never invoked, the same
 * reason `npm install` never is.
 *
 * A wheel is always a zip, never npm's gzipped tarball, so this does not
 * reuse `registry.ts`'s `tar -xzf` extraction. It also does not shell out to
 * `unzip`: the system `tar` here happens to be `bsdtar`, which reads zip
 * files too, but the GNU `tar` most Linux hosts ship does not, and `unzip`
 * itself is not guaranteed present — and Emend's whole pitch is `npx
 * emend-cli` working cold on a stranger's machine (see `parser.ts`'s module
 * doc for the same argument about the WASM grammar). `node:zlib` ships raw
 * DEFLATE (`inflateRawSync`), which is exactly what a zip's "deflate" storage
 * method is, so reading the format directly costs a small parser and no new
 * dependency, and works identically everywhere Node does.
 *
 * A limit worth stating plainly: hand-rolling the reader means no entry name
 * is trusted as a safe relative path. `registry.ts`'s npm extraction gets
 * zip-slip protection for free from the system `tar` binary; this reader has
 * none except the explicit check `extractZip` does itself — every entry's
 * resolved destination is verified to stay inside `destDir` before anything
 * is written, and an entry that would escape it (`../../../etc/passwd`) is
 * rejected outright rather than skipped quietly. Every scanned Python
 * dependency has its wheel fetched and extracted here on an ordinary `emend
 * scan`, no `--fix` or opt-in required, so without that check a single
 * malicious or typosquatted release would be enough for arbitrary file write
 * with the scanning process's own privileges.
 */

import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { CACHE_ROOT } from '../registry.ts';
import type { PackageVersions, RegistryClient } from '../registry.ts';

/** The slice of PyPI's JSON API response `toPackageVersions` reads. */
interface PyPIPackageDoc {
  info?: { version?: string | null };
  releases?: Record<string, unknown>;
}

/**
 * Maps PyPI's JSON API response onto the neutral `PackageVersions` shape.
 *
 * Exported so PyPI's JSON shape can be tested without a network call.
 */
export function toPackageVersions(doc: PyPIPackageDoc, name: string): PackageVersions {
  return {
    name,
    versions: Object.keys(doc.releases ?? {}),
    latest: doc.info?.version ?? null,
  };
}

/** The slice of a version-specific PyPI JSON response `pickWheel` reads. */
interface PyPIVersionDoc {
  urls?: { filename: string; packagetype: string; url: string }[];
}

/**
 * The wheel to download for `pkg@version`, preferring a universal
 * (`py3-none-any`/`py2.py3-none-any`) build when one was published.
 *
 * A platform-specific wheel (`cp311-manylinux...`) still ships the package's
 * `.py` sources alongside its compiled extension — only the compiled parts
 * are platform-bound — so falling back to whichever wheel exists is still
 * useful when no universal build was published.
 *
 * Throws when no wheel exists at all, rather than falling back to the sdist
 * or returning an empty directory. Both would answer the question with
 * something nobody actually read: the sdist would need its own build code
 * executed just to be read (module doc), and an empty directory extracts as
 * a package with no public API, which diffs against any real version as
 * "nothing changed".
 */
function pickWheel(
  doc: PyPIVersionDoc,
  pkg: string,
  version: string,
): { filename: string; url: string } {
  const wheels = (doc.urls ?? []).filter((u) => u.packagetype === 'bdist_wheel');
  const wheel = wheels.find((w) => w.filename.includes('-none-any.whl')) ?? wheels[0];
  if (!wheel) {
    const published = (doc.urls ?? []).map((u) => u.packagetype);
    throw new Error(
      `${pkg}@${version} publishes no wheel on PyPI (only ${
        published.length > 0 ? published.join(', ') : 'nothing'
      }); Emend does not build from an sdist, because that runs the package's own setup code`,
    );
  }
  return wheel;
}

// ---------------------------------------------------------------------------
// Minimal zip reading — see the module doc for why this isn't `tar`/`unzip`.
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;

/** Scans backward for the end-of-central-directory record. */
function findEndOfCentralDirectory(buf: Buffer): number {
  const scanFrom = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= scanFrom; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new Error('not a zip file: no end-of-central-directory record found');
}

/**
 * Reads a zip's central directory — the authoritative file list. Sizes are
 * taken from here, not from each local header, because some writers leave
 * the local header's copy zeroed when using a trailing data descriptor.
 */
function readCentralDirectory(buf: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buf);
  const count = buf.readUInt16LE(eocd + 10);
  const offset = buf.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff || count === 0xffff) {
    // zip64 exists for archives past 4GB or 65,535 entries. A Python wheel
    // approaches neither, so this is reported rather than misread as empty.
    throw new Error('zip64 archives are not supported');
  }

  const entries: ZipEntry[] = [];
  let p = offset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CENTRAL_DIR_SIGNATURE) {
      throw new Error(`corrupt zip: central directory entry ${i} has a bad signature`);
    }
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, method, compressedSize, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Decompresses one entry. Wheels use only `stored` (0) and `deflate` (8) —
 * the two methods every zip writer in the Python packaging toolchain emits —
 * so any other method is reported rather than guessed at.
 */
function readZipEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const p = entry.localHeaderOffset;
  if (buf.readUInt32LE(p) !== LOCAL_HEADER_SIGNATURE) {
    throw new Error(`corrupt zip: local header for ${entry.name} has a bad signature`);
  }
  // The local header's own name/extra lengths, not the central directory's —
  // the two commonly disagree (the central directory often carries a Unix
  // file-attributes extra field the local header does not).
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const dataStart = p + 30 + nameLen + extraLen;
  const raw = buf.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`unsupported zip compression method ${entry.method} for ${entry.name}`);
}

/**
 * Extracts every entry of a zip buffer under `destDir`.
 *
 * Exported (only) so tests can exercise extraction directly, the same reason
 * `python/callsites.ts`'s `pythonSites` is exported — this is otherwise an
 * internal step of `fetchWheelDirUncached`.
 *
 * Every entry's destination is verified to resolve inside `destDir` before
 * anything is written. See the module doc for why: this reader has no other
 * zip-slip protection, and a wheel is fetched and extracted on an ordinary
 * scan with no opt-in.
 */
export async function extractZip(buf: Buffer, destDir: string): Promise<void> {
  const destRoot = path.resolve(destDir);
  for (const entry of readCentralDirectory(buf)) {
    const dest = path.join(destDir, ...entry.name.split('/'));
    const rel = path.relative(destRoot, path.resolve(dest));
    // A traversal entry (`../../../PWNED.txt`) is hostile, not malformed —
    // continuing to extract the rest of the archive while saying nothing
    // would be the wrong response, the same reasoning `readCentralDirectory`
    // and `readZipEntry` apply to zip64 and an unsupported compression
    // method. `rel` escapes `destDir` when it is exactly `..`, or starts
    // with a `..` *segment* (checked with the platform separator, not a bare
    // string prefix, so a file legitimately named e.g. `..bashrc` is not
    // mistaken for one), or — crossing drives on Windows — is itself
    // absolute. Empty means `dest` resolved to `destDir` itself, which is
    // never a real file to write.
    if (
      rel === '' ||
      rel === '..' ||
      rel.startsWith(`..${path.sep}`) ||
      path.isAbsolute(rel)
    ) {
      throw new Error(`zip entry escapes its extraction directory: ${entry.name}`);
    }
    if (entry.name.endsWith('/')) {
      await mkdir(dest, { recursive: true });
      continue;
    }
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, readZipEntry(buf, entry));
  }
}

// ---------------------------------------------------------------------------
// Fetch + cache, mirroring registry.ts's layout and in-flight dedup.
// ---------------------------------------------------------------------------

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * In-flight wheel fetches, keyed by `pkg@version` — the same corruption
 * `registry.ts`'s own map exists to prevent: two callers extracting the same
 * package version at once would otherwise both write into `dest` and corrupt
 * each other's output. A separate map from `registry.ts`'s (npm and PyPI
 * fetches never share a key), so no cross-ecosystem interference either.
 */
const inFlight = new Map<string, Promise<string>>();

function fetchWheelDir(pkg: string, version: string): Promise<string> {
  const key = `${pkg}@${version}`;
  const running = inFlight.get(key);
  if (running) return running;
  const task = fetchWheelDirUncached(pkg, version).finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}

async function fetchWheelDirUncached(pkg: string, version: string): Promise<string> {
  // Shares `registry.ts`'s cache root and its per-package/version layout —
  // unlike npm's tarballs, a wheel has no wrapping `package/` directory of
  // its own, so this extracts straight into the version directory. `pkg`
  // needs no `+`-encoding the way a scoped npm name does: PyPI names never
  // contain `/`. Landing beside npm's own cache entries is what keeps
  // `emend cache list`/`prune` working across both ecosystems without a
  // second code path (module doc).
  const dest = path.join(CACHE_ROOT, pkg, version);
  if (await pathExists(dest)) return dest;

  const metaUrl = `https://pypi.org/pypi/${pkg}/${version}/json`;
  const metaRes = await fetch(metaUrl);
  if (!metaRes.ok) {
    throw new Error(`PyPI ${metaRes.status} for ${pkg}@${version} (${metaUrl})`);
  }
  const wheel = pickWheel((await metaRes.json()) as PyPIVersionDoc, pkg, version);

  const wheelRes = await fetch(wheel.url);
  if (!wheelRes.ok) {
    throw new Error(`${wheel.url} returned ${wheelRes.status} for ${pkg}@${version}`);
  }
  const buf = Buffer.from(await wheelRes.arrayBuffer());

  // Staged under a random name and only renamed into place once extraction
  // finishes, so a half-extracted directory is never visible at `dest` — the
  // same atomicity `registry.ts` relies on for npm tarballs.
  const staging = path.join(
    CACHE_ROOT,
    '.staging',
    `${pkg}-${version}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(staging, { recursive: true });
  try {
    await extractZip(buf, staging);
    await mkdir(path.dirname(dest), { recursive: true });
    try {
      await rename(staging, dest);
    } catch {
      // `dest` already exists: another worker finished first, or an earlier
      // run left a half-written directory behind. Replace only in the latter
      // case, so the cache heals itself rather than failing every scan after.
      if (!(await pathExists(dest))) {
        await rm(dest, { recursive: true, force: true });
        await rename(staging, dest);
      }
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return dest;
}

export function pypiClient(): RegistryClient {
  return {
    id: 'pypi',
    handles: (ecosystem) => ecosystem === 'PyPI',

    async versions(pkg) {
      const url = `https://pypi.org/pypi/${pkg}/json`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`PyPI ${res.status} for ${pkg} (${url})`);
      }
      return toPackageVersions((await res.json()) as PyPIPackageDoc, pkg);
    },

    fetch: fetchWheelDir,
  };
}
