/**
 * What a repository depends on, per ecosystem.
 *
 * The detector used to read `package-lock.json` directly, which meant a
 * repository in any other ecosystem was never screened — and reported nothing,
 * which reads exactly like having checked. An adapter that claims a repository
 * is the only thing that makes it screened, so claiming is the contract.
 *
 * `manifestSite` is here rather than in the detector because pointing at the
 * line that names a package is a fact about the ecosystem's own lockfile, and
 * the detector should not know that npm writes install paths.
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { readLockfile } from './lockfile.ts';
import type { InstalledPackage } from './osv.ts';
import type { CallSite } from './types.ts';

export interface InventoryResult {
  packages: InstalledPackage[];
  /** A manifest found but not parseable, for an honest warning. Never silent. */
  unsupported: string | null;
}

export interface EcosystemInventory {
  id: string;
  /** OSV's ecosystem key: `npm`, `PyPI`, `crates.io`. */
  osvEcosystem: string;
  applies(repoDir: string): Promise<boolean>;
  read(repoDir: string): Promise<InventoryResult>;
  /** Where this package is named in the ecosystem's own manifest, if anywhere. */
  manifestSite(repoDir: string, pkg: InstalledPackage): Promise<CallSite | null>;
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

function npmInventory(): EcosystemInventory {
  return {
    id: 'npm',
    osvEcosystem: 'npm',

    async applies(repoDir) {
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

    async manifestSite(repoDir, pkg) {
      const lock = await readLockfile(repoDir);
      // Nothing was parsed, so there is nothing to cite. Citing
      // package-lock.json regardless used to fabricate evidence pointing at a
      // file that was never on disk for a pnpm/yarn/bun repository — a false
      // citation, which is worse than none.
      const kind = lock.kind;
      if (kind === null) return null;

      let installPath = pkg.name;
      for (const entry of lock.tree.values()) {
        if (entry.name === pkg.name && entry.version === pkg.version) {
          installPath = entry.installPath;
          break;
        }
      }
      let raw: string;
      try {
        raw = await readFile(path.join(repoDir, kind), 'utf8');
      } catch {
        return null;
      }
      return lockfileSite(kind, raw, installPath);
    },
  };
}

// Every inventory a repository can be screened against. Registering one here is
// what makes it screened at all — an ecosystem left out of this array behaves
// exactly like one that was never written: `applies` finds nothing, the scan
// reports zero findings, and that reads identically to a clean repository. See
// the module doc for the bug this array exists to stop from recurring.
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
