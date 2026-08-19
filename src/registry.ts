/**
 * npm registry client: version metadata and tarball extraction.
 *
 * Tarballs are cached on disk under ~/.emend/cache so repeated scans of the same
 * dependency set are fast. A cold scan of a handful of packages is network-bound;
 * a warm one is not.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, writeFile, readdir, access, rename, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { compareVersions, isPrerelease } from './versions.ts';
import { pypiClient } from './python/pypi.ts';

const execFileAsync = promisify(execFile);

const REGISTRY = process.env.EMEND_REGISTRY ?? 'https://registry.npmjs.org';
export const CACHE_ROOT =
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

/**
 * A package's published versions, in a shape no ecosystem's wire format leaks
 * into. `Packument` stays npm's own and is not part of this contract.
 */
export interface PackageVersions {
  name: string;
  versions: string[];
  /** What a bare install gets: npm's `latest` tag, PyPI's `info.version`. */
  latest: string | null;
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

/**
 * The version we should compare against: `pack.latest`, which is what a bare
 * install would get.
 *
 * Deliberately not "highest version" — packages publish prereleases and
 * back-ported patches to older majors under other tags, and neither is what the
 * user would actually receive.
 */
export function resolveTargetVersion(pack: PackageVersions): string | null {
  const latest = pack.latest;
  if (latest && pack.versions.includes(latest)) return latest;
  const stable = pack.versions
    .filter((v) => !isPrerelease(v))
    .sort(compareVersions);
  return stable.at(-1) ?? null;
}

/**
 * In-flight fetches, keyed by `pkg@version`.
 *
 * Staging a lockfile requests the same package from several install paths at
 * once — an alias and its real name, or a nested copy npm chose not to dedupe.
 * Without this, those callers each download and each extract into the same
 * directory, and they corrupt one another. That is what made
 * `@google-cloud/storage@7.21.0` fail to stage while succeeding in isolation.
 */
const inFlight = new Map<string, Promise<string>>();

/**
 * Download and extract a package version, returning the directory containing its
 * package.json. Cached; a second call for the same version does no network I/O,
 * and concurrent callers share one download.
 */
export function fetchPackageDir(pkg: string, version: string): Promise<string> {
  const key = `${pkg}@${version}`;
  const running = inFlight.get(key);
  if (running) return running;

  const task = fetchPackageDirUncached(pkg, version).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, task);
  return task;
}

async function fetchPackageDirUncached(
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

  // Stage inside the cache root so the final move is a rename on the same
  // filesystem rather than a cross-device copy.
  const staging = await mkdtempDir(path.join(CACHE_ROOT, '.staging'));
  const tgz = path.join(staging, 'pkg.tgz');
  const extracted = path.join(staging, 'out');
  await writeFile(tgz, buf);
  await mkdir(extracted, { recursive: true });

  try {
    // System tar handles npm's gzipped tarballs; every npm tarball extracts to
    // a top-level `package/` directory.
    await execFileAsync('tar', ['-xzf', tgz, '-C', extracted]);

    // Publish the finished tree in one atomic step. A half-extracted directory
    // must never be visible under `dest`, because another process sharing this
    // cache would take it for a complete package.
    await mkdir(path.dirname(dest), { recursive: true });
    try {
      await rename(extracted, dest);
    } catch {
      // `dest` already exists. Either another worker finished first — in which
      // case its copy is complete and preferable — or an earlier run left a
      // half-written directory behind. Replace only in the latter case, so the
      // cache heals itself rather than failing every scan from then on.
      if (!(await exists(path.join(pkgRoot, 'package.json')))) {
        await rm(dest, { recursive: true, force: true });
        await rename(extracted, dest);
      }
    }
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

/**
 * Resolve a semver range to a concrete published version.
 *
 * This is deliberately not a full semver implementation — it covers exact pins,
 * `^`, `~`, and the wildcard/comparator forms, and falls back to `pack.latest`
 * for anything more exotic. It is used only to place *type dependencies* on
 * disk so declarations resolve; the versions Emend actually diffs come from
 * the lockfile or node_modules, never from here.
 */
export function resolveRange(pack: PackageVersions, range: string): string | null {
  const published = pack.versions.filter((v) => !isPrerelease(v));
  if (published.length === 0) return null;
  const latest = resolveTargetVersion(pack);

  const spec = (range ?? '').trim();
  if (spec === '' || spec === '*' || spec === 'x' || spec === 'latest') return latest;

  // A single comparator is all we interpret; `a || b` and `>=a <b` take the first.
  const first = spec.split('||')[0]?.trim().split(/\s+/)[0] ?? '';
  const m = first.match(/^([\^~]|>=|>|<=|<|=|v)?\s*(\d+)\.(\d+)\.(\d+)/);
  if (!m) return latest;

  const [, op, majS = '0', minS = '0', patS = '0'] = m;
  const [maj, min, pat] = [Number(majS), Number(minS), Number(patS)];
  const floor = `${maj}.${min}.${pat}`;

  // Exact pin, or a comparator we do not model precisely: prefer the pin when it
  // exists, otherwise latest. Guessing wide is worse than guessing narrow here.
  if (op === undefined || op === '=' || op === 'v') {
    return pack.versions.includes(floor) ? floor : latest;
  }
  if (op === '>' || op === '>=' || op === '<' || op === '<=') return latest;

  // `^` allows changes that do not modify the left-most non-zero component;
  // `~` allows patch-level changes. Both are floored at the stated version.
  const inRange = (v: string): boolean => {
    if (compareVersions(v, floor) < 0) return false;
    const [vMaj = 0, vMin = 0] = v.split('.').map((n) => Number.parseInt(n, 10) || 0);
    if (op === '~') return vMaj === maj && vMin === min;
    if (maj > 0) return vMaj === maj;
    if (min > 0) return vMaj === 0 && vMin === min;
    return v === floor;
  };

  const best = published.filter(inRange).sort(compareVersions).at(-1);
  return best ?? (pack.versions.includes(floor) ? floor : latest);
}

/** `@scope/pkg/sub` -> `@scope/pkg`; `pkg/sub` -> `pkg`. */
export function packageNameOfSpecifier(spec: string): string | null {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) return null;
  const parts = spec.split('/');
  if (spec.startsWith('@')) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }
  return parts[0] ?? null;
}

async function mkdtempDir(root: string = tmpdir()): Promise<string> {
  const dir = path.join(root, `emend-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Looking at the cache, and getting rid of it
// ---------------------------------------------------------------------------

/**
 * One cached package.
 *
 * Note what is *not* here: any notion of which repository wanted it. The cache
 * is keyed by package and version — one `zod/4.4.3` entry serves every
 * repository that ever resolved that version — so it cannot be pruned per
 * repository, and pretending otherwise would delete another project's warm
 * cache. Scan history is repo-scoped and lives in the store; this is not.
 */
export interface CachedPackage {
  /** The real package name, decoded from its on-disk form. */
  pkg: string;
  versions: string[];
  bytes: number;
  /** Most recently touched version, which is what "in use" means here. */
  lastUsed: string;
}

/** Bytes under a directory, following the tree rather than trusting its own size. */
async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirBytes(full);
    else if (entry.isFile()) {
      try {
        total += (await stat(full)).size;
      } catch {
        /* vanished mid-walk, which costs a few bytes of accuracy and nothing else */
      }
    }
  }
  return total;
}

/**
 * What is in the cache, largest first.
 *
 * A missing root is an empty cache rather than an error: a fresh install has
 * never fetched anything, and asking what is cached is a reasonable first thing
 * to do.
 */
export async function listCache(root: string = CACHE_ROOT): Promise<CachedPackage[]> {
  let dirs;
  try {
    dirs = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const packages: CachedPackage[] = [];
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    // `.staging` is where `fetchPackageDirUncached` unpacks a tarball before
    // renaming it into place, so it is scratch rather than a package — and a
    // prune that treated it as one would delete a download that is still in
    // flight. npm forbids a package name beginning with a dot, so this excludes
    // exactly the scratch and nothing real.
    if (entry.name.startsWith('.')) continue;
    const dir = path.join(root, entry.name);
    const versions = (await readdir(dir, { withFileTypes: true }).catch(() => []))
      .filter((v) => v.isDirectory())
      .map((v) => v.name)
      .sort();

    let newest = 0;
    for (const version of versions) {
      const when = await stat(path.join(dir, version))
        .then((s) => s.mtimeMs)
        .catch(() => 0);
      if (when > newest) newest = when;
    }

    packages.push({
      // `cacheKey` replaces the first `/` only, and a package name has at most
      // one, so this is exact rather than a best guess.
      pkg: entry.name.replace('+', '/'),
      versions,
      bytes: await dirBytes(dir),
      lastUsed: newest ? new Date(newest).toISOString() : '',
    });
  }

  return packages.sort((a, b) => b.bytes - a.bytes);
}

export interface CachePruneOptions {
  /** A single package, by its real name. */
  pkg?: string;
  /** Packages whose newest version has not been touched in this many days. */
  olderThanDays?: number;
  all?: boolean;
}

/**
 * Delete cached packages, and report what went.
 *
 * Throws when given no target. `--all` deletes gigabytes, and an options object
 * that arrived empty by mistake must not be read as the one instruction that
 * cannot be undone — the same reason a scan with nothing to do says so rather
 * than reporting success.
 *
 * Age is taken per package from its *newest* version, so a package still in
 * daily use is never dropped because one stale version of it is sitting there.
 *
 * `pkg` and `olderThanDays` narrow together rather than one winning: every
 * constraint given has to hold. `--all` is the one that ignores the others,
 * because it is not a filter — it is the statement that there is nothing to
 * filter by. Deciding it by precedence instead meant `--pkg zod --older-than 30`
 * silently deleted zod at any age, which is a flag the operator typed and the
 * code declined to read.
 */
export async function pruneCache(
  options: CachePruneOptions,
  root: string = CACHE_ROOT,
): Promise<{ packages: number; bytes: number }> {
  if (!options.all && !options.pkg && options.olderThanDays === undefined) {
    throw new Error('nothing to prune: name a package, an age, or --all');
  }
  // Rejected here rather than allowed to become a `NaN` cutoff. Every
  // comparison against `NaN` is false, so an unparseable age turns whichever
  // predicate it lands in into its own opposite — `emend store cache prune
  // --older-than abc` is either "delete nothing" or "delete all 13GB" depending
  // on which way the test happens to be written, and neither is what was typed.
  if (options.olderThanDays !== undefined && !Number.isFinite(options.olderThanDays)) {
    throw new Error('an age must be a number of days');
  }

  const cached = await listCache(root);
  const cutoff =
    options.olderThanDays === undefined
      ? undefined
      : Date.now() - options.olderThanDays * 24 * 60 * 60 * 1000;

  const doomed = cached.filter((entry) => {
    if (options.all) return true;
    if (options.pkg !== undefined && entry.pkg !== options.pkg) return false;
    if (cutoff !== undefined) {
      // Stated as "provably older", not as "not newer". A package whose
      // timestamp could not be read has an unknown age, and unknown is not old
      // enough to delete on — the cardinal rule, pointed at the one operation
      // here that cannot be undone.
      const lastUsed = entry.lastUsed ? new Date(entry.lastUsed).getTime() : Number.NaN;
      if (!(lastUsed < cutoff)) return false;
    }
    return true;
  });

  let bytes = 0;
  for (const entry of doomed) {
    // `cacheKey`, not a second copy of it: the directory name is that function's
    // output, and re-deriving it here is how the two drift into deleting the
    // wrong path.
    await rm(path.join(root, cacheKey(entry.pkg)), { recursive: true, force: true });
    bytes += entry.bytes;
  }
  return { packages: doomed.length, bytes };
}

/**
 * One ecosystem's registry: where a package's published versions and tarball
 * come from.
 *
 * `versions` returns the neutral `PackageVersions` shape rather than
 * `Packument` — npm's own wire format — so a crates.io or PyPI client
 * satisfying this contract is never forced to fabricate `dist-tags` or a
 * `dist.tarball` field it does not have. An ecosystem with no client is absent
 * from the registry below, never present with an implementation that invents
 * versions nobody published.
 */
export interface RegistryClient {
  id: string;
  /** Whether this client resolves packages published under `ecosystem`. */
  handles(ecosystem: string): boolean;
  /** This package's published versions, and what a bare install would get. */
  versions(pkg: string): Promise<PackageVersions>;
  /** Download and extract, returning the directory. Never runs install scripts. */
  fetch(pkg: string, version: string): Promise<string>;
}

function npmClient(): RegistryClient {
  return {
    id: 'npm',
    handles: (ecosystem) => ecosystem === 'npm',
    async versions(pkg) {
      const pack = await fetchPackument(pkg);
      return {
        name: pack.name,
        versions: Object.keys(pack.versions ?? {}),
        latest: pack['dist-tags']?.latest ?? null,
      };
    },
    fetch: fetchPackageDir,
  };
}

// Every registry a package's versions and tarball can be resolved from.
// Registering one here is what makes an ecosystem resolvable at all — leaving
// one out is not a crash, it is `clientFor` returning `undefined`, which
// callers must handle explicitly rather than assume away.
const CLIENTS: RegistryClient[] = [npmClient(), pypiClient()];

export function clientFor(ecosystem: string): RegistryClient | undefined {
  return CLIENTS.find((c) => c.handles(ecosystem));
}
