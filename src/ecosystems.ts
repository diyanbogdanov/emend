/**
 * What a repository depends on, per ecosystem.
 *
 * The detector used to read `package-lock.json` directly, which meant a
 * repository in any other ecosystem was never screened — and reported nothing,
 * which reads exactly like having checked. An adapter that claims a repository
 * is the only thing that makes it screened, so claiming is the contract.
 *
 * Two views of "depends on" live here, because two callers need different
 * answers: `read()` is the whole installed tree, flat, for vulnerability
 * screening; `declared()` is the direct dependencies with the ranges the
 * manifest states, for upgrade analysis. `declared()` is what `readRepo`
 * (inventory.ts) used to answer itself, by reading `package.json` directly and
 * throwing when absent — the same npm-only gate this module exists to remove,
 * just on the analysis path rather than the screening one. `inventory.ts` is
 * now a thin router in front of `declared()` here.
 *
 * `manifestSites` is here rather than in the detector because pointing at the
 * line that names a package is a fact about the ecosystem's own lockfile, and
 * the detector should not know that npm writes install paths.
 */

import path from 'node:path';
import { readFile, access } from 'node:fs/promises';
import { readLockfile } from './lockfile.ts';
import { findWorkspaces } from './workspaces.ts';
import type { InstalledPackage } from './osv.ts';
import type { CallSite, InstalledDependency, RepoInfo } from './types.ts';

export interface InventoryResult {
  packages: InstalledPackage[];
  /** A manifest found but not parseable, for an honest warning. Never silent. */
  unsupported: string | null;
}

export interface EcosystemInventory {
  id: string;
  /**
   * OSV's ecosystem key: `npm`, `PyPI`, `crates.io`. Assumed unique per
   * registered inventory — if two ever share one, whichever is registered
   * first silently wins and the second is never consulted.
   */
  osvEcosystem: string;
  /**
   * The manifest filenames this inventory looks for.
   *
   * Declared rather than inferred because `applies` is a predicate and cannot be
   * asked what it examined. It exists so `readRepo` can tell a user what was
   * actually looked for — naming files no adapter reads would be the "nobody
   * looked" claim this codebase refuses to make.
   */
  manifests: string[];
  applies(repoDir: string): Promise<boolean>;
  read(repoDir: string): Promise<InventoryResult>;
  /**
   * Declared direct dependencies, with the ranges the manifest states.
   *
   * A different question from `read()`, which returns the whole transitive tree
   * flat for vulnerability screening. This is the upgrade-analysis view: what the
   * repository asks for, not everything it ends up with. Both live here because
   * both are facts about how this ecosystem records dependencies.
   */
  declared(repoDir: string): Promise<RepoInfo>;
  /**
   * Where each of these packages is named in the ecosystem's own manifest.
   *
   * Batch rather than per-package because the answer comes from one parse of one
   * file: asking per package re-read a 50,000-entry lockfile once per finding.
   * Keyed `name@version`; a package with no locatable manifest line is absent
   * from the map rather than present with a fabricated site.
   */
  manifestSites(
    repoDir: string,
    packages: InstalledPackage[],
  ): Promise<Map<string, CallSite>>;
}

/**
 * The line in `file` that names this package, so a finding can point at it.
 *
 * Originally `detectors.ts`'s `lockfileSite`, which hardcoded `file` to
 * `package-lock.json` — the only lockfile it ever cited, even for a
 * repository that had a different one entirely and no `package-lock.json` on
 * disk at all. `file` is now a parameter so this only ever cites a lockfile
 * that is actually there; the caller is responsible for that guarantee.
 *
 * The search is for the install path *in quotes*, which is how npm writes it
 * (`"node_modules/qs": {`). pnpm, yarn and bun install paths are synthesized
 * by `readLockfile` rather than read off the page, so for those the search
 * will usually miss and fall through to line 1 — that fallback is honest, not
 * an artifact: the package genuinely is named somewhere in `file`, this just
 * did not pinpoint the line. `column` is likewise never computed. `via:
 * 'import'` is a stretch for a manifest reference — `CallSite.via` is only
 * `'import' | 'type'` — but widening that union changes what every renderer
 * prints, which a behaviour-neutral refactor must not do. Worth revisiting
 * when something other than npm has a manifest to point at.
 */
function lockfileSite(file: string, lockfile: string, installPath: string): CallSite {
  const lines = lockfile.split('\n');
  const index = lines.findIndex((l) => l.includes(`"${installPath}"`));
  return {
    file,
    line: index === -1 ? 1 : index + 1,
    column: 1,
    text: installPath,
    via: 'import',
  };
}

interface RepoManifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
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

function npmInventory(): EcosystemInventory {
  return {
    id: 'npm',
    osvEcosystem: 'npm',
    // What `applies` below actually checks: a bare `package.json`, or any of
    // the four lockfiles `readLockfile` can parse. `bun.lockb` is excluded on
    // purpose — `readLockfile` recognises it too, but only to report it as
    // unsupported; finding it alone (no package.json, no parseable lockfile)
    // does not make `applies` return true, so it is not actually looked for
    // in the sense this list promises.
    manifests: ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock'],

    async applies(repoDir) {
      // A `package.json` alone is enough to have declared dependencies worth
      // analysing; a lockfile alone is enough to have an installed tree worth
      // screening. Gating on the lockfile only would stop `readRepo` working for
      // repositories it handles today.
      if (await exists(path.join(repoDir, 'package.json'))) return true;
      return (await readLockfile(repoDir)).tree.size > 0;
    },

    async read(repoDir) {
      const lock = await readLockfile(repoDir);
      // The whole tree, not the direct dependencies. Most vulnerabilities in a
      // real repository are transitive, and screening only what package.json
      // names would miss the majority of them.
      //
      // Deduplicated by name@version: the tree lists every install path, and a
      // package installed twice is one package to screen, not two.
      const seen = new Set<string>();
      const packages: InstalledPackage[] = [];
      for (const entry of lock.tree.values()) {
        const key = `${entry.name}@${entry.version}`;
        if (seen.has(key)) continue;
        seen.add(key);
        packages.push({ name: entry.name, ecosystem: 'npm', version: entry.version });
      }
      return { packages, unsupported: lock.unsupported };
    },

    /**
     * The version that matters is the concrete one a build would resolve, not
     * the range in package.json — `"^3.22.0"` tells you nothing about whether
     * the repo is running 3.22.0 or 3.24.1, and the whole analysis is a diff
     * against a concrete version. Worse, a range can name a version that was
     * never published: `"typescript": "^5.7.0"` inferred naively yields 5.7.0,
     * which does not exist.
     *
     * Sources are tried in order of decreasing certainty — node_modules, then
     * the lockfile, then the range — and which one answered is recorded on each
     * entry so a guess is never reported as a reading.
     *
     * Moved here from `inventory.ts`'s `readRepo`. `applies()` now covers
     * "nothing claims this repository at all" — the router throws for that —
     * but not "the manifest it found does not parse"; `applies()` checks
     * existence, never validity, so that failure is still this method's to
     * report.
     */
    async declared(repoDir) {
      const warnings: string[] = [];
      const manifestPath = path.join(repoDir, 'package.json');

      // `applies()` only checks that `package.json` exists, never that it
      // parses — an unresolved merge-conflict marker is an ordinary real-world
      // state, needing no broken repo, just a bad commit. Re-thrown with the
      // path so the error names which manifest failed, the same context the
      // pre-router `readRepo` always gave.
      let manifest: RepoManifest;
      try {
        manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as RepoManifest;
      } catch (err) {
        throw new Error(`unreadable package.json at ${manifestPath}: ${(err as Error).message}`);
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
    },

    async manifestSites(repoDir, packages) {
      const lock = await readLockfile(repoDir);
      // Nothing was parsed, so there is nothing to cite for anyone. Citing
      // package-lock.json regardless used to fabricate evidence pointing at a
      // file that was never on disk for a pnpm/yarn/bun repository — a false
      // citation, which is worse than none.
      const kind = lock.kind;
      if (kind === null) return new Map();

      let raw: string;
      try {
        raw = await readFile(path.join(repoDir, kind), 'utf8');
      } catch {
        return new Map();
      }

      // One pass over the tree builds every install path this call could
      // need, rather than re-scanning it once per package as manifestSite
      // used to — the parse and the read above already happened only once.
      const installPaths = new Map<string, string>();
      for (const entry of lock.tree.values()) {
        const key = `${entry.name}@${entry.version}`;
        if (!installPaths.has(key)) installPaths.set(key, entry.installPath);
      }

      const sites = new Map<string, CallSite>();
      for (const pkg of packages) {
        const key = `${pkg.name}@${pkg.version}`;
        const installPath = installPaths.get(key) ?? pkg.name;
        sites.set(key, lockfileSite(kind, raw, installPath));
      }
      return sites;
    },
  };
}

// Every inventory a repository can be screened against. Registering one here is
// what makes it screened at all — an ecosystem left out of this array behaves
// exactly like one that was never written: `applies` finds nothing, the scan
// reports zero findings, and that reads identically to a clean repository.
// `readRepo` (inventory.ts) walks this same array to route analysis, not just
// screening — an unregistered ecosystem's repository is not only unscreened,
// `readRepo` throws for it rather than guessing. See the module doc for the
// bug this array exists to stop from recurring.
const INVENTORIES: EcosystemInventory[] = [npmInventory()];

/**
 * Every inventory that claims this repository.
 *
 * A repository can be more than one — a Rust workspace with a JS toolchain is
 * both, and screening only the first would be a silent half-answer.
 */
export async function inventoriesFor(
  repoDir: string,
  registry: EcosystemInventory[] = INVENTORIES,
): Promise<EcosystemInventory[]> {
  const claimed: EcosystemInventory[] = [];
  for (const inventory of registry) {
    if (await inventory.applies(repoDir)) claimed.push(inventory);
  }
  return claimed;
}

/** The inventory that reads this OSV ecosystem, if one is registered. */
export function inventoryFor(osvEcosystem: string): EcosystemInventory | undefined {
  return INVENTORIES.find((i) => i.osvEcosystem === osvEcosystem);
}

/**
 * Every manifest filename any registered inventory looks for.
 *
 * For `readRepo`'s "nothing claims this repository" message: derived so it
 * names exactly what is registered today and extends itself the moment a new
 * ecosystem does — a list kept by hand next to that message would drift the
 * first time an adapter landed and nobody remembered to update the string.
 */
export function registeredManifests(): string[] {
  return INVENTORIES.flatMap((i) => i.manifests);
}
