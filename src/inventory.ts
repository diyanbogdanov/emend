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
 * Best-effort concrete version from a semver range, used only when node_modules
 * is absent. Marked distinctly by the caller so we never imply we read it from disk.
 */
function versionFromRange(range: string): string | null {
  const m = range.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  return m?.[1] ?? null;
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

  const dependencies: InstalledDependency[] = [];
  const groups: Array<[Record<string, string> | undefined, boolean]> = [
    [manifest.dependencies, false],
    [manifest.devDependencies, true],
  ];

  for (const [group, dev] of groups) {
    for (const [name, declared] of Object.entries(group ?? {})) {
      // Local and git dependencies have no registry version to diff against.
      if (/^(file:|link:|workspace:|git\+|https?:)/.test(declared)) continue;

      // Precedence is by decreasing certainty: what is actually on disk, then
      // what the lockfile says would be installed, then a guess from the range.
      let installed: string | null = null;
      let source: InstalledDependency['source'] = 'none';

      if (hasNodeModules) {
        try {
          const dm = JSON.parse(
            await readFile(
              path.join(repoDir, 'node_modules', name, 'package.json'),
              'utf8',
            ),
          ) as { version?: string };
          if (dm.version) {
            installed = dm.version;
            source = 'node_modules';
          }
        } catch {
          /* fall through to the lockfile */
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

      dependencies.push({ name, declared, dev, installed, source });
    }
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
  };
}
