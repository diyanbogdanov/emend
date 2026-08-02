/**
 * Reads what a repository actually depends on.
 *
 * The version that matters is the one resolved on disk in node_modules, not the
 * range in package.json — `"^3.22.0"` tells you nothing about whether the repo is
 * running 3.22.0 or 3.24.1, and the whole analysis is a diff against a concrete
 * version.
 */

import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import type { InstalledDependency } from './types.ts';

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
  if (!hasNodeModules) {
    warnings.push(
      'node_modules is missing — installed versions were inferred from package.json ranges, and call-site type resolution will be degraded. Run `npm install` in the target repo for full fidelity.',
    );
  }

  const dependencies: InstalledDependency[] = [];
  const groups: Array<[Record<string, string> | undefined, boolean]> = [
    [manifest.dependencies, false],
    [manifest.devDependencies, true],
  ];

  for (const [group, dev] of groups) {
    for (const [name, declared] of Object.entries(group ?? {})) {
      // Local and git dependencies have no registry version to diff against.
      if (/^(file:|link:|workspace:|git\+|https?:)/.test(declared)) continue;

      let installed: string | null = null;
      if (hasNodeModules) {
        try {
          const dm = JSON.parse(
            await readFile(
              path.join(repoDir, 'node_modules', name, 'package.json'),
              'utf8',
            ),
          ) as { version?: string };
          installed = dm.version ?? null;
        } catch {
          installed = null;
        }
      }
      if (!installed) installed = versionFromRange(declared);

      dependencies.push({ name, declared, dev, installed });
    }
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
