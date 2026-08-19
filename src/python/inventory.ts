/**
 * The PyPI ecosystem inventory: what a Python repository declares and has
 * installed, read from whichever of `uv.lock`, `poetry.lock`, `pdm.lock`,
 * `Pipfile.lock` or `requirements.txt` the repository actually has.
 *
 * Tried in that order — resolution-quality order, per `MANIFEST_ORDER`'s own
 * doc — because the four lockfiles record an install a resolver actually
 * produced, while `requirements.txt` records only what was asked for. Where a
 * lockfile exists it answers alone; `requirements.txt` is never consulted
 * alongside one, because mixing a resolution for one package with a range for
 * another would report one installed version carrying the other's provenance.
 *
 * `applies()` also treats a bare `pyproject.toml` as claiming the repository —
 * a real Python project with no lockfile committed yet is still a Python
 * project worth naming as one — but `declared()` has nothing to read from
 * `pyproject.toml` alone: its `[project.dependencies]` is not one of the five
 * formats `../python/manifests.ts` parses (see that module's doc for why), so
 * that case reports zero dependencies with a warning rather than guessing at
 * ranges nobody read.
 *
 * Registered in `../ecosystems.ts`'s `INVENTORIES`, which is what makes a
 * Python repository screened at all — see that module's doc for the bug this
 * exists to stop from recurring.
 */

import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { readPythonManifest, type PythonManifest, type PythonManifestKind } from './manifests.ts';
import type { EcosystemInventory } from '../ecosystems.ts';
import type { CallSite, InstalledDependency, RepoInfo } from '../types.ts';
import type { InstalledPackage } from '../osv.ts';

/**
 * Resolution-quality order: a true lockfile before the one format that is
 * only ever a range. Among the four lockfiles themselves there is no ranking
 * to make — a repository migrating between tools might have more than one on
 * disk, but a repository using exactly one Python package manager, which is
 * the ordinary case, has at most one of these four to begin with. Newest and
 * most actively developed first (uv), oldest last (Pipenv), purely as a
 * tie-break for the migrating-repository case, not a claim that uv's
 * resolution is more trustworthy than Poetry's.
 */
const MANIFEST_ORDER: PythonManifestKind[] = [
  'uv.lock',
  'poetry.lock',
  'pdm.lock',
  'Pipfile.lock',
  'requirements.txt',
];

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

interface BestManifest {
  kind: PythonManifestKind;
  /** Kept alongside the parsed result so `manifestSites` need not re-read the file. */
  text: string;
  manifest: PythonManifest;
}

/**
 * The highest-resolution-quality manifest this repository actually has, read
 * once.
 *
 * Existence decides which manifest is "best", not content quality — the first
 * candidate in `MANIFEST_ORDER` that is present on disk is read and returned,
 * even if its content turns out to be unreadable (`manifest.unsupported` says
 * so); the next candidate is tried only when the file itself is absent. This
 * mirrors `../lockfile.ts`'s `readLockfile`, which does the same for npm: a
 * `package-lock.json` that fails to parse is reported as such, never silently
 * skipped in favour of a `pnpm-lock.yaml` that happens to parse.
 */
async function readBestManifest(repoDir: string): Promise<BestManifest | null> {
  for (const kind of MANIFEST_ORDER) {
    let text: string;
    try {
      text = await readFile(path.join(repoDir, kind), 'utf8');
    } catch {
      continue;
    }
    return { kind, text, manifest: readPythonManifest(kind, text) };
  }
  return null;
}

/**
 * The line in `raw` that names `name`, so a finding can point at it.
 *
 * `Pipfile.lock` is JSON, so its packages are named by an object key
 * (`"requests": {`); the four other kinds are the TOML shape `manifests.ts`
 * reads, named by `name = "requests"`. Both needles are quoted so a shorter
 * package name cannot match inside a longer one's line (`requests` inside
 * `requests-toolbelt`) — the same reasoning `../ecosystems.ts`'s `lockfileSite`
 * gives for quoting an npm install path.
 *
 * `via: 'import'` is the same stretch `lockfileSite` makes: `CallSite.via` is
 * only `'import' | 'type'`, neither of which a manifest reference really is,
 * but widening that union changes what every renderer prints, which this is
 * not the place to do.
 */
function pythonManifestSite(kind: PythonManifestKind, raw: string, name: string): CallSite {
  const needle = kind === 'Pipfile.lock' ? `"${name}": {` : `name = "${name}"`;
  const lines = raw.split('\n');
  const index = lines.findIndex((l) => l.includes(needle));
  return {
    file: kind,
    line: index === -1 ? 1 : index + 1,
    column: 1,
    text: name,
    via: 'import',
  };
}

export function pythonInventory(): EcosystemInventory {
  return {
    id: 'python',
    osvEcosystem: 'PyPI',
    manifests: [...MANIFEST_ORDER, 'pyproject.toml'],

    async applies(repoDir) {
      for (const kind of MANIFEST_ORDER) {
        if (await exists(path.join(repoDir, kind))) return true;
      }
      // No lockfile and no requirements.txt is still a Python repository if
      // pyproject.toml says so — just one `declared()` cannot read dependency
      // ranges from (see the module doc).
      return exists(path.join(repoDir, 'pyproject.toml'));
    },

    async read(repoDir) {
      const best = await readBestManifest(repoDir);
      if (!best) return { packages: [], unsupported: null };

      // Every entry in a resolved manifest, not just direct dependencies —
      // uv.lock, poetry.lock, pdm.lock and Pipfile.lock all record the whole
      // resolved tree, so this needs no separate transitive walk the way a
      // manifest-only format would. `requirements.txt` has no resolved
      // versions at all (`best.manifest.versions` is empty for it, by
      // `readPythonManifest`'s contract) — screening a range as if it were an
      // installed version would mean asking OSV about a version nobody
      // confirmed is actually on disk, which is the exact fabrication
      // `InstalledDependency.source`'s `'range'` case exists to flag on the
      // `declared()` side. `read()` has no such provenance field to flag it
      // with, so the honest answer here is nothing rather than a guess.
      const packages: InstalledPackage[] = [];
      for (const [name, version] of best.manifest.versions) {
        packages.push({ name, ecosystem: 'PyPI', version });
      }
      return { packages, unsupported: best.manifest.unsupported };
    },

    async declared(repoDir) {
      const warnings: string[] = [];
      const best = await readBestManifest(repoDir);

      if (!best) {
        warnings.push(
          'found pyproject.toml but none of uv.lock, poetry.lock, pdm.lock, ' +
            'Pipfile.lock or requirements.txt — dependencies could not be read',
        );
        return {
          dir: repoDir,
          name: path.basename(repoDir),
          dependencies: [],
          scripts: {},
          warnings,
          workspaces: [''],
        };
      }

      const dependencies: InstalledDependency[] = [];

      if (best.manifest.resolved) {
        for (const [name, version] of best.manifest.versions) {
          dependencies.push({
            name,
            // The lockfile records the resolution, not the range that
            // produced it — that lives in pyproject.toml, which this adapter
            // does not parse (see the module doc) — so the resolved version
            // is the truest string available for `declared`.
            declared: version,
            // Simplification: uv.lock and poetry.lock do record which group
            // (dev, test, …) a package belongs to; this reads neither. Every
            // dependency is reported as a runtime one, which over-reports
            // rather than under-reports — a dev dependency screened for
            // vulnerabilities unnecessarily is the safe direction to be
            // wrong in, unlike the reverse.
            dev: false,
            installed: version,
            source: 'lockfile',
            declaredIn: [''],
          });
        }
      } else {
        for (const [name, range] of best.manifest.declared) {
          dependencies.push({
            name,
            declared: range,
            dev: false,
            // A range "may name a version that was never published —
            // callers must not present it as a fact read from the
            // repository" (`InstalledDependency.source`'s own doc), so
            // `installed` stays null rather than guessing.
            installed: null,
            source: 'range',
            declaredIn: [''],
          });
        }
        warnings.push(
          `${best.kind} declares ranges, not resolved versions — installed versions ` +
            'could not be confirmed and are not guessed',
        );
      }

      if (best.manifest.unsupported) {
        warnings.push(
          `found ${best.kind}, which Emend could not read — no dependencies were recovered from it`,
        );
      }

      return {
        dir: repoDir,
        name: path.basename(repoDir),
        dependencies,
        // npm-shaped and read by nothing: no detector or renderer consults a
        // Python repository's scripts today. Left empty rather than invented
        // — pyproject.toml's `[project.scripts]` and tox/nox sessions are not
        // this field's shape, and nothing here reads them.
        scripts: {},
        warnings,
        workspaces: [''],
      };
    },

    async manifestSites(repoDir, packages) {
      const best = await readBestManifest(repoDir);
      if (!best) return new Map();

      const sites = new Map<string, CallSite>();
      for (const pkg of packages) {
        sites.set(`${pkg.name}@${pkg.version}`, pythonManifestSite(best.kind, best.text, pkg.name));
      }
      return sites;
    },
  };
}
