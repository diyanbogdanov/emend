/**
 * npm registry client: version metadata and tarball extraction.
 *
 * Tarballs are cached on disk under ~/.emend/cache so repeated scans of the same
 * dependency set are fast. A cold scan of a handful of packages is network-bound;
 * a warm one is not.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, writeFile, readdir, readFile, access, symlink, rename } from 'node:fs/promises';
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
 * `^`, `~`, and the wildcard/comparator forms, and falls back to the `latest`
 * dist-tag for anything more exotic. It is used only to place *type
 * dependencies* on disk so declarations resolve; the versions Emend actually
 * diffs come from the lockfile or node_modules, never from here.
 */
export function resolveRange(pack: Packument, range: string): string | null {
  const published = Object.keys(pack.versions ?? {}).filter((v) => !isPrerelease(v));
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
    return pack.versions?.[floor] ? floor : latest;
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
  return best ?? (pack.versions?.[floor] ? floor : latest);
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

const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto',
  'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https', 'inspector',
  'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring',
  'readline', 'repl', 'stream', 'string_decoder', 'timers', 'tls', 'trace_events',
  'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

/** Bare module specifiers referenced by a package's declaration files. */
async function declarationImports(dir: string, fileCap: number): Promise<Set<string>> {
  const found = new Set<string>();
  const files: string[] = [];

  const walk = async (d: string): Promise<void> => {
    if (files.length >= fileCap) return;
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= fileCap) return;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        await walk(full);
      } else if (/\.d\.[cm]?ts$/.test(e.name)) {
        files.push(full);
      }
    }
  };
  await walk(dir);

  // `from 'x'`, `import('x')`, `require('x')`, and `/// <reference types="x" />`.
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /<reference\s+types\s*=\s*['"]([^'"]+)['"]/g,
  ];

  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    for (const re of patterns) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const name = packageNameOfSpecifier(m[1] ?? '');
        if (name && !NODE_BUILTINS.has(name)) found.add(name);
      }
    }
  }
  return found;
}

/**
 * How far to chase type dependencies.
 *
 * The trade-off is scan latency against surface completeness. `playwright`'s
 * declarations re-export from `playwright-core`, so at depth 0 its surface comes
 * back empty and Emend reports "ships no type declarations" about a package that
 * plainly does. Chasing the full closure instead would download an unbounded
 * dependency tree for every package on every scan.
 *
 * Depth 2 covers the common shape — a facade package over a core package, which
 * may itself reference one shared types package — without opening the door to
 * transitively downloading half the registry. Raise it if you see hollow
 * surfaces; the cost is roughly linear in packages fetched.
 */
const TYPE_DEP_DEPTH = 2;
const TYPE_DEP_FILE_CAP = 400;
const TYPE_DEP_TOTAL_CAP = 24;

interface DepManifest {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

/**
 * Place a package's declaration dependencies in a sibling `node_modules` so that
 * TypeScript's own resolver finds them.
 *
 * The cache layout is `<root>/<pkg>/<version>/package/`, so writing to
 * `<root>/<pkg>/<version>/node_modules/` means the standard upward walk from any
 * declaration file lands on it — no custom CompilerHost required. A single flat
 * directory serves the whole closure, exactly as npm's own hoisting does.
 *
 * Best-effort throughout: a dependency that cannot be fetched leaves that part
 * of the surface unresolved, which is strictly better than failing the scan.
 */
export async function materializeTypeDeps(pkgDir: string): Promise<string[]> {
  const nmDir = path.join(path.dirname(pkgDir), 'node_modules');
  const stamp = path.join(nmDir, '.emend-roots.json');
  try {
    return JSON.parse(await readFile(stamp, 'utf8')) as string[];
  } catch {
    /* not yet materialised */
  }

  // The real cache directories, not the node_modules paths. TypeScript resolves
  // symlinks to their realpath, so a caller checking "is this declaration part
  // of the package's type closure?" must compare against these.
  const roots: string[] = [];
  const seen = new Set<string>();
  let queue: Array<{ dir: string; depth: number }> = [{ dir: pkgDir, depth: 0 }];

  while (queue.length > 0) {
    const next: Array<{ dir: string; depth: number }> = [];
    for (const { dir, depth } of queue) {
      if (depth >= TYPE_DEP_DEPTH || seen.size >= TYPE_DEP_TOTAL_CAP) continue;

      let manifest: DepManifest = {};
      try {
        manifest = JSON.parse(
          await readFile(path.join(dir, 'package.json'), 'utf8'),
        ) as DepManifest;
      } catch {
        continue;
      }

      const imports = await declarationImports(dir, TYPE_DEP_FILE_CAP);
      for (const name of imports) {
        if (seen.has(name) || seen.size >= TYPE_DEP_TOTAL_CAP) continue;

        // Only follow declared dependencies. An undeclared bare import in a
        // .d.ts is either a global types package the consumer supplies or a
        // genuine publishing bug; fetching a guess would be worse than leaving
        // it unresolved.
        const range = manifest.dependencies?.[name] ?? manifest.peerDependencies?.[name];
        if (range === undefined) continue;
        if (/^(file:|link:|workspace:|git\+|https?:)/.test(range)) continue;

        seen.add(name);
        try {
          const pack = await fetchPackument(name);
          const version = resolveRange(pack, range);
          if (!version) continue;
          const depDir = await fetchPackageDir(name, version);
          const target = path.join(nmDir, name);
          await mkdir(path.dirname(target), { recursive: true });
          await linkTree(depDir, target);
          roots.push(depDir);
          next.push({ dir: depDir, depth: depth + 1 });
        } catch {
          /* unreachable dependency: leave that part of the surface unresolved */
        }
      }
    }
    queue = next;
  }

  await mkdir(nmDir, { recursive: true });
  await writeFile(stamp, JSON.stringify(roots));
  return roots;
}

/**
 * Expose an already-extracted cache directory at a second path.
 *
 * A symlink would be enough for TypeScript, but the same cached tarball is
 * referenced from many packages' node_modules, and a real copy would multiply
 * disk use by the number of dependents.
 */
async function linkTree(from: string, to: string): Promise<void> {
  if (await exists(to)) return;
  await mkdir(path.dirname(to), { recursive: true });
  await symlink(from, to, 'dir');
}

async function mkdtempDir(root: string = tmpdir()): Promise<string> {
  const dir = path.join(root, `emend-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}
