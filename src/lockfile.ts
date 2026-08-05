/**
 * Reads resolved dependency versions from a lockfile.
 *
 * This is what lets Emend analyse a repository it has not installed. A lockfile
 * records the exact version npm resolved for every dependency, which is the same
 * fact `node_modules/<pkg>/package.json` carries — without needing to run
 * `npm install`, and therefore without executing any package's install scripts.
 *
 * That last point is the reason this module exists at all: running `npm install`
 * on a customer repository is arbitrary code execution. Dependabot solves the
 * same problem the same way, parsing manifests rather than installing them.
 *
 * Only npm's `package-lock.json` is parsed. yarn.lock and pnpm-lock.yaml use
 * bespoke formats (and pnpm's needs a YAML parser, which would be Emend's first
 * runtime dependency). When one of those is present we say so explicitly rather
 * than silently falling back to guessing versions out of semver ranges.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Where a concrete version came from. Callers surface this; never imply disk. */
export type VersionSource = 'node_modules' | 'lockfile' | 'range';

export interface LockfileResult {
  /** Package name -> resolved version, for top-level installs only. */
  versions: Map<string, string>;
  /**
   * Every entry in the lockfile, keyed by its install path relative to the
   * repository root (`node_modules/a`, `node_modules/a/node_modules/b`).
   *
   * The nested paths matter. They are how npm expresses two packages needing
   * incompatible versions of a third, and flattening them would silently give
   * one of those packages the wrong version's types.
   */
  tree: Map<string, LockEntry>;
  /** Which lockfile was read, for reporting. */
  kind: 'package-lock.json' | null;
  /** A lockfile we found but cannot parse, for an honest warning. */
  unsupported: string | null;
}

export interface LockEntry {
  /**
   * The name to fetch from the registry.
   *
   * Not always the same as the directory it installs into: an aliased
   * dependency installs at `node_modules/string-width-cjs` but is published as
   * `string-width`.
   */
  name: string;
  version: string;
  /** Install path relative to the repository root. */
  installPath: string;
  dev: boolean;
}

interface NpmLockV3 {
  lockfileVersion?: number;
  packages?: Record<
    string,
    {
      version?: string;
      link?: boolean;
      dev?: boolean;
      resolved?: string;
      /** Present for aliased installs: the real published package name. */
      name?: string;
    }
  >;
  dependencies?: Record<string, { version?: string }>;
}

const UNSUPPORTED_LOCKFILES = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];

/**
 * Read resolved versions from the repository's lockfile.
 *
 * Never throws: a missing or malformed lockfile degrades to range inference,
 * which the caller reports as lower-fidelity rather than treating as authoritative.
 */
export async function readLockfile(repoDir: string): Promise<LockfileResult> {
  const empty: LockfileResult = {
    versions: new Map(),
    tree: new Map(),
    kind: null,
    unsupported: null,
  };

  let raw: string;
  try {
    raw = await readFile(path.join(repoDir, 'package-lock.json'), 'utf8');
  } catch {
    for (const name of UNSUPPORTED_LOCKFILES) {
      try {
        await readFile(path.join(repoDir, name), 'utf8');
        return { ...empty, unsupported: name };
      } catch {
        /* not this one */
      }
    }
    return empty;
  }

  let lock: NpmLockV3;
  try {
    lock = JSON.parse(raw) as NpmLockV3;
  } catch {
    return empty;
  }

  const versions = new Map<string, string>();
  const tree = new Map<string, LockEntry>();

  // lockfileVersion 2 and 3: a flat `packages` map keyed by install path.
  for (const [installPath, entry] of Object.entries(lock.packages ?? {})) {
    if (installPath === '') continue; // the root project itself
    if (entry?.link) continue; // workspace symlink, no registry version
    if (!entry?.version) continue;
    // Entries without a registry tarball (git, file, http) cannot be fetched.
    if (entry.resolved && !/^https?:\/\//.test(entry.resolved)) continue;

    // An aliased dependency (`"string-width-cjs": "npm:string-width@^4"`) is
    // installed under the alias but published under its real name, which the
    // lockfile records in `name`. Deriving the name from the path instead asks
    // the registry for `string-width-cjs`, which does not exist — so the alias
    // silently failed to stage and every call site importing it was missed.
    const name = entry.name ?? nameFromInstallPath(installPath);
    if (name) {
      tree.set(installPath, {
        name,
        version: entry.version,
        installPath,
        dev: entry.dev === true,
      });
    }

    // `versions` stays top-level only: it answers "what does this repo's own
    // code resolve when it imports X", and a nested entry answers that question
    // for some dependency, not for the repo.
    const top = topLevelName(installPath);
    if (top) versions.set(top, entry.version);
  }

  // lockfileVersion 1: a nested `dependencies` tree. Its top level is what the
  // root resolves, so nested entries are ignored for the same reason as above.
  if (versions.size === 0) {
    for (const [name, entry] of Object.entries(lock.dependencies ?? {})) {
      if (!entry?.version) continue;
      versions.set(name, entry.version);
      const installPath = `node_modules/${name}`;
      tree.set(installPath, { name, version: entry.version, installPath, dev: false });
    }
  }

  return { versions, tree, kind: 'package-lock.json', unsupported: null };
}

/** Package name from any install path, however deeply nested. */
function nameFromInstallPath(installPath: string): string | null {
  const marker = 'node_modules/';
  const last = installPath.lastIndexOf(marker);
  if (last === -1) return null;
  const rest = installPath.slice(last + marker.length);
  if (rest === '' || rest.includes('/node_modules/')) return null;
  if (rest.startsWith('@')) {
    const parts = rest.split('/');
    return parts.length === 2 ? rest : null;
  }
  return rest.includes('/') ? null : rest;
}

/**
 * `node_modules/zod` -> `zod`, `node_modules/@scope/pkg` -> `@scope/pkg`.
 * Anything nested deeper returns null.
 */
function topLevelName(installPath: string): string | null {
  if (!installPath.startsWith('node_modules/')) return null;
  const rest = installPath.slice('node_modules/'.length);
  if (rest.includes('/node_modules/')) return null;
  if (rest.startsWith('@')) {
    const parts = rest.split('/');
    return parts.length === 2 ? rest : null;
  }
  return rest.includes('/') ? null : rest;
}
