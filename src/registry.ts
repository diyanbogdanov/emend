/**
 * npm registry client: version metadata and tarball extraction.
 *
 * Tarballs are cached on disk under ~/.emend/cache so repeated scans of the same
 * dependency set are fast. A cold scan of a handful of packages is network-bound;
 * a warm one is not.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, writeFile, readdir, access } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const REGISTRY = process.env.EMEND_REGISTRY ?? 'https://registry.npmjs.org';
const CACHE_ROOT =
  process.env.EMEND_CACHE ?? path.join(homedir(), '.emend', 'cache');

export interface PackumentVersion {
  version: string;
  dist: { tarball: string };
}

export interface Packument {
  name: string;
  'dist-tags': Record<string, string>;
  versions: Record<string, PackumentVersion>;
}

/** Filesystem-safe cache key for a package name (scoped names contain `/`). */
function cacheKey(pkg: string): string {
  return pkg.replace('/', '+');
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function fetchPackument(pkg: string): Promise<Packument> {
  const url = `${REGISTRY}/${pkg.replace('/', '%2F')}`;
  const res = await fetch(url, {
    headers: {
      // Abbreviated packument: same version list, far less payload.
      Accept: 'application/vnd.npm.install-v1+json',
    },
  });
  if (!res.ok) {
    throw new Error(`registry ${res.status} for ${pkg} (${url})`);
  }
  return (await res.json()) as Packument;
}

/** Numeric-aware semver compare. Returns <0, 0, >0. Prerelease sorts before release. */
export function compareVersions(a: string, b: string): number {
  const [aCore = '', aPre = ''] = a.split('-', 2);
  const [bCore = '', bPre = ''] = b.split('-', 2);
  const aParts = aCore.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const bParts = bCore.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (aPre === bPre) return 0;
  if (aPre === '') return 1; // release > prerelease
  if (bPre === '') return -1;
  return aPre < bPre ? -1 : 1;
}

export function isPrerelease(v: string): boolean {
  return v.includes('-');
}

/**
 * The version we should compare against: the `latest` dist-tag, which is what a
 * developer running `npm install pkg` would get.
 *
 * Deliberately not "highest version" — packages publish prereleases and
 * back-ported patches to older majors under other tags, and neither is what the
 * user would actually receive.
 */
export function resolveTargetVersion(pack: Packument): string | null {
  const latest = pack['dist-tags']?.latest;
  if (latest && pack.versions?.[latest]) return latest;
  const stable = Object.keys(pack.versions ?? {})
    .filter((v) => !isPrerelease(v))
    .sort(compareVersions);
  return stable.at(-1) ?? null;
}

/**
 * Download and extract a package version, returning the directory containing its
 * package.json. Cached; a second call for the same version does no network I/O.
 */
export async function fetchPackageDir(
  pkg: string,
  version: string,
): Promise<string> {
  const dest = path.join(CACHE_ROOT, cacheKey(pkg), version);
  const pkgRoot = path.join(dest, 'package');

  if (await exists(path.join(pkgRoot, 'package.json'))) return pkgRoot;

  const pack = await fetchPackument(pkg);
  const meta = pack.versions?.[version];
  if (!meta) {
    throw new Error(`version ${version} not published for ${pkg}`);
  }

  const res = await fetch(meta.dist.tarball);
  if (!res.ok) {
    throw new Error(`tarball ${res.status} for ${pkg}@${version}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());

  const staging = await mkdtempDir();
  const tgz = path.join(staging, 'pkg.tgz');
  await writeFile(tgz, buf);
  await mkdir(dest, { recursive: true });

  try {
    // System tar handles npm's gzipped tarballs; every npm tarball extracts to
    // a top-level `package/` directory.
    await execFileAsync('tar', ['-xzf', tgz, '-C', dest]);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  if (await exists(path.join(pkgRoot, 'package.json'))) return pkgRoot;

  // Rare: a publisher used a different top-level directory name.
  const entries = await readdir(dest, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory()) {
      const candidate = path.join(dest, e.name);
      if (await exists(path.join(candidate, 'package.json'))) return candidate;
    }
  }
  throw new Error(`extracted ${pkg}@${version} but found no package.json`);
}

async function mkdtempDir(): Promise<string> {
  const dir = path.join(tmpdir(), `emend-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}
