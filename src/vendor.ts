/**
 * Stages a repository's dependencies without running `npm install`.
 *
 * Lockfile parsing told Emend which versions a repo resolves, which fixed
 * version reporting. It did not help the TypeScript program: with no
 * `node_modules`, imports do not resolve, types collapse, and type-based call
 * site matching finds far less than it should. Measured on a real repository,
 * the same scan found 5 breaking changes across 54 call sites with dependencies
 * present and 2 across 22 without — the hosted product was seeing under half of
 * what the CLI saw on identical code.
 *
 * Packages are symlinked from the shared tarball cache rather than copied, so
 * staging a repo costs almost nothing on disk and is near-instant once warm.
 * Crucially, no install scripts run: tarballs are extracted, never executed.
 * That preserves the property the whole hosted design rests on.
 */

import { mkdir, symlink, readFile, access, rm } from 'node:fs/promises';
import path from 'node:path';
import { fetchPackageDir } from './registry.ts';
import { readLockfile, type LockEntry } from './lockfile.ts';
import type { InstalledDependency } from './types.ts';

export interface VendorResult {
  /** Packages successfully placed in node_modules. */
  linked: number;
  /** Packages that could not be fetched, with the reason. */
  failed: Array<{ pkg: string; reason: string }>;
  /** Executables exposed under node_modules/.bin. */
  binaries: number;
}

interface PackageManifest {
  bin?: string | Record<string, string>;
  name?: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        const item = items[index];
        if (item === undefined) return;
        out[index] = await fn(item);
      }
    }),
  );
  return out;
}

/**
 * Expose a package's executables under `node_modules/.bin`.
 *
 * Without this, `npx --no-install tsc` cannot find the compiler even with the
 * `typescript` package present, so a staged repository can be analysed but not
 * typechecked. npm creates these links during install; nothing else does.
 */
async function linkBinaries(
  pkgDir: string,
  pkgName: string,
  binDir: string,
): Promise<number> {
  let manifest: PackageManifest;
  try {
    manifest = JSON.parse(await readFile(path.join(pkgDir, 'package.json'), 'utf8')) as PackageManifest;
  } catch {
    return 0;
  }
  if (!manifest.bin) return 0;

  // `bin` is either a path (the command takes the package's unscoped name) or a
  // map of command name to path.
  const entries: Array<[string, string]> =
    typeof manifest.bin === 'string'
      ? [[pkgName.split('/').at(-1) ?? pkgName, manifest.bin]]
      : Object.entries(manifest.bin);

  let count = 0;
  for (const [command, relative] of entries) {
    if (typeof relative !== 'string') continue;
    const target = path.resolve(pkgDir, relative);
    if (!(await exists(target))) continue;
    const link = path.join(binDir, command);
    if (await exists(link)) continue;
    try {
      await symlink(target, link, 'file');
      count++;
    } catch {
      /* a name collision between two packages: first one wins, as with npm */
    }
  }
  return count;
}

/**
 * Reconstruct a repository's `node_modules` from its lockfile.
 *
 * The whole tree is staged, at the exact install paths the lockfile specifies,
 * not just direct dependencies. Staging only direct dependencies was tried and
 * measurably failed: on a real repository it left 386 type errors of the form
 * `Property 'not' does not exist on type 'Assertion<…>'`, because vitest's chai
 * augmentation lives in transitive packages. Types are a transitive property —
 * a direct dependency whose own type dependencies are missing is not usable.
 *
 * Only hoisted top-level entries are staged. A nested `node_modules/a/node_modules/b`
 * cannot be created here: `node_modules/a` is a symlink into the shared cache,
 * so writing beneath it resolves through the link and mutates the cached copy of
 * `a` that every other repository shares. That really happened — a staging run
 * left `~/.emend/cache/tsx/4.21.0/package/node_modules/fsevents` behind.
 *
 * Nothing is lost by skipping them. npm hoists almost everything, so nested
 * entries exist only where two packages need incompatible versions of a third,
 * and that case is already handled correctly elsewhere: `materializeTypeDeps`
 * resolves each package's own declared ranges into a sibling directory beside
 * its cache entry, which is where TypeScript looks after resolving the symlink.
 *
 * Everything is a symlink into the shared tarball cache, so a warm stage costs
 * essentially nothing and packages are downloaded once across all repositories.
 * No install scripts run at any point.
 *
 * Refuses to touch an existing `node_modules`: a real checkout's installed tree
 * is authoritative and better than anything reconstructed here.
 */
export async function materializeRepoDeps(
  repoDir: string,
  fallbackDeps: InstalledDependency[],
  onProgress: (message: string) => void = () => {},
): Promise<VendorResult> {
  const nodeModules = path.join(repoDir, 'node_modules');
  if (await exists(nodeModules)) {
    return { linked: 0, failed: [], binaries: 0 };
  }

  const lock = await readLockfile(repoDir);
  // Without a parsable lockfile the transitive set is unknown, so fall back to
  // direct dependencies. Type resolution will be partial and the caller reports
  // the lockfile situation separately.
  const isTopLevel = (installPath: string): boolean =>
    installPath.startsWith('node_modules/') &&
    !installPath.slice('node_modules/'.length).includes('node_modules/');

  const entries: LockEntry[] =
    lock.tree.size > 0
      ? [...lock.tree.values()].filter((e) => isTopLevel(e.installPath))
      : fallbackDeps
          .filter((d): d is InstalledDependency & { installed: string } => d.installed !== null)
          .map((d) => ({
            name: d.name,
            version: d.installed,
            installPath: `node_modules/${d.name}`,
            dev: d.dev,
          }));

  if (entries.length === 0) return { linked: 0, failed: [], binaries: 0 };

  const binDir = path.join(nodeModules, '.bin');
  await mkdir(binDir, { recursive: true });

  onProgress(
    `staging ${entries.length} package(s) from ${lock.tree.size > 0 ? 'the lockfile' : 'package.json'}`,
  );

  let done = 0;
  const results = await mapLimit(entries, 12, async (entry) => {
    try {
      const pkgDir = await fetchPackageDir(entry.name, entry.version);
      const target = path.join(repoDir, entry.installPath);
      await mkdir(path.dirname(target), { recursive: true });
      try {
        await symlink(pkgDir, target, 'dir');
      } catch (err) {
        // EEXIST means another worker created it first; the link is identical
        // either way. Checking first and then creating is a race, not a fix.
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const binaries = await linkBinaries(pkgDir, entry.name, binDir);
      return { ok: true as const, binaries };
    } catch (err) {
      return {
        ok: false as const,
        pkg: `${entry.name}@${entry.version}`,
        reason: (err as Error).message.slice(0, 120),
      };
    } finally {
      done++;
      if (done % 250 === 0) onProgress(`  staged ${done}/${entries.length}`);
    }
  });

  const failed = results
    .filter((r): r is { ok: false; pkg: string; reason: string } => !r.ok)
    .map(({ pkg, reason }) => ({ pkg, reason }));
  const linked = results.length - failed.length;
  const binaries = results.reduce((sum, r) => sum + (r.ok ? r.binaries : 0), 0);

  onProgress(
    `staged ${linked}/${entries.length} package(s), ${binaries} executable(s)` +
      (failed.length > 0 ? `, ${failed.length} unavailable` : ''),
  );
  return { linked, failed, binaries };
}

/** Remove a staged tree. Only ever called on directories this module created. */
export async function removeStagedDeps(repoDir: string): Promise<void> {
  await rm(path.join(repoDir, 'node_modules'), { recursive: true, force: true });
}
