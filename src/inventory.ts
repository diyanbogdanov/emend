/**
 * Reads what a repository actually depends on.
 *
 * The version that matters is the concrete one a build would resolve, not the
 * range in package.json — `"^3.22.0"` tells you nothing about whether the repo is
 * running 3.22.0 or 3.24.1, and the whole analysis is a diff against a concrete
 * version. Worse, a range can name a version that was never published:
 * `"typescript": "^5.7.0"` inferred naively yields 5.7.0, which does not exist.
 *
 * Sources are tried in order of decreasing certainty — node_modules, then the
 * lockfile, then the range — and which one answered is recorded on each entry so
 * a guess is never reported as a reading.
 */

import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import type { InstalledDependency } from './types.ts';
import { readLockfile } from './lockfile.ts';
import { findWorkspaces } from './workspaces.ts';

interface RepoManifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

export interface RepoInfo {
  dir: string;
  name: string;
  dependencies: InstalledDependency[];
  scripts: Record<string, string>;
  /** Non-fatal problems worth telling the user about. */
  warnings: string[];
  /** Manifest directories read, relative to the root. `''` is the root. */
  workspaces: string[];
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort concrete version from a semver range, the fallback when neither
 * node_modules nor the lockfile answered. Marked distinctly by the caller so we
 * never imply we read it from disk.
 */
function versionFromRange(range: string): string | null {
  const m = range.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  return m?.[1] ?? null;
}

async function readManifest(file: string): Promise<RepoManifest | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as RepoManifest;
  } catch {
    return null;
  }
}

export async function readRepo(repoDir: string): Promise<RepoInfo> {
  const warnings: string[] = [];
  const manifestPath = path.join(repoDir, 'package.json');

  let manifest: RepoManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as RepoManifest;
  } catch (err) {
    throw new Error(
      `no readable package.json at ${manifestPath}: ${(err as Error).message}`,
    );
  }

  const hasNodeModules = await exists(path.join(repoDir, 'node_modules'));
  const lock = await readLockfile(repoDir);

  // Every workspace manifest, not just the root. A monorepo root usually
  // declares a few tooling devDependencies and nothing else; the dependencies
  // that matter are in packages/*, and reading only the root reports such a
  // repository as clean.
  const workspaces = await findWorkspaces(repoDir);

  // Keyed by package name: one dependency can be declared by several
  // workspaces, and the lockfile resolves it to a single version for all of
  // them. Merging keeps one finding per package while remembering every
  // manifest that would need editing to migrate it.
  const byName = new Map<string, InstalledDependency>();

  for (const workspace of workspaces) {
    const wsManifest =
      workspace === ''
        ? manifest
        : await readManifest(path.join(repoDir, workspace, 'package.json'));
    if (!wsManifest) continue;

    const groups: Array<[Record<string, string> | undefined, boolean]> = [
      [wsManifest.dependencies, false],
      [wsManifest.devDependencies, true],
    ];

    for (const [group, dev] of groups) {
      for (const [name, declared] of Object.entries(group ?? {})) {
        // Local and git dependencies have no registry version to diff against.
        // `workspace:*` is how a monorepo references its own packages.
        if (/^(file:|link:|workspace:|git\+|https?:|catalog:|npm:file)/.test(declared)) continue;

        const existing = byName.get(name);
        if (existing) {
          if (!existing.declaredIn.includes(workspace)) existing.declaredIn.push(workspace);
          // A package needed at runtime anywhere is not a dev dependency.
          if (!dev) existing.dev = false;
          continue;
        }

        // Precedence is by decreasing certainty: what is actually on disk, then
        // what the lockfile says would be installed, then a guess from the range.
        let installed: string | null = null;
        let source: InstalledDependency['source'] = 'none';

        if (hasNodeModules) {
          // Workspaces hoist to the root node_modules; check the workspace's own
          // first for the cases where a version conflict prevented hoisting.
          for (const base of workspace === ''
            ? [repoDir]
            : [path.join(repoDir, workspace), repoDir]) {
            try {
              const dm = JSON.parse(
                await readFile(path.join(base, 'node_modules', name, 'package.json'), 'utf8'),
              ) as { version?: string };
              if (dm.version) {
                installed = dm.version;
                source = 'node_modules';
                break;
              }
            } catch {
              /* try the next location, then the lockfile */
            }
          }
        }
        if (!installed) {
          const locked = lock.versions.get(name);
          if (locked) {
            installed = locked;
            source = 'lockfile';
          }
        }
        if (!installed) {
          installed = versionFromRange(declared);
          if (installed) source = 'range';
        }

        byName.set(name, {
          name,
          declared,
          dev,
          installed,
          source,
          declaredIn: [workspace],
        });
      }
    }
  }

  const dependencies = [...byName.values()];
  if (workspaces.length > 1) {
    warnings.push(
      `workspace repository: read ${workspaces.length} manifests (${workspaces
        .slice(1, 5)
        .join(', ')}${workspaces.length > 5 ? ', …' : ''})`,
    );
  }

  const guessed = dependencies.filter((d) => d.source === 'range');
  if (lock.unsupported) {
    warnings.push(
      `found ${lock.unsupported}, which Emend could not read — versions for ${guessed.length} package(s) were inferred from package.json ranges and may name versions that were never published. package-lock.json, pnpm-lock.yaml and yarn.lock are supported.`,
    );
  } else if (guessed.length > 0) {
    warnings.push(
      `no resolved version on disk or in a lockfile for: ${guessed.map((d) => d.name).join(', ')} — inferred from the declared range, which may name a version that was never published.`,
    );
  }

  const unresolved = dependencies.filter((d) => d.installed === null);
  if (unresolved.length > 0) {
    warnings.push(
      `could not resolve an installed version for: ${unresolved.map((d) => d.name).join(', ')} — these were skipped, not cleared`,
    );
  }

  return {
    dir: repoDir,
    name: manifest.name ?? path.basename(repoDir),
    dependencies,
    scripts: manifest.scripts ?? {},
    warnings,
    workspaces,
  };
}
