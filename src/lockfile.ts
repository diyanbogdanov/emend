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
 * npm, pnpm, yarn and bun are all parsed. None of them needs a YAML parser: the facts
 * Emend wants — package name, resolved version — live in the *keys* of these
 * files (`zod@3.25.76:`, `"zod@npm:^3.24.0":`), which are matchable line by
 * line. A real YAML parser would be Emend's first runtime dependency and would
 * buy nothing, since the nested values are exactly the parts not needed here.
 *
 * Being deliberately shallow has a cost worth stating: these parsers understand
 * the shapes in circulation today and will not silently adapt to a new lockfile
 * format. An unrecognised file yields no versions, which the caller reports as
 * degraded rather than treating as an empty dependency set.
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
  kind: 'package-lock.json' | 'pnpm-lock.yaml' | 'yarn.lock' | 'bun.lock' | null;
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

/** bun.lockb is a binary format with no stable public spec; bun.lock is text. */
const UNSUPPORTED_LOCKFILES = ['bun.lockb'];

/**
 * bun.lock — JSON with trailing commas, which `JSON.parse` rejects.
 *
 * Its `packages` map is `name: ["name@version", registry, deps, integrity]`.
 * The version is read from element zero rather than the key, because a key can
 * be a nested path (`parent/child`) when Bun needs two versions of a package,
 * while element zero always spells the real `name@version`.
 */
function parseBunLock(raw: string): Map<string, string> {
  const versions = new Map<string, string>();

  // Strip trailing commas before `}` or `]`. Bun writes them; JSON forbids them.
  const stripped = raw.replace(/,(\s*[}\]])/g, '$1');
  let doc: { packages?: Record<string, unknown> };
  try {
    doc = JSON.parse(stripped) as { packages?: Record<string, unknown> };
  } catch {
    return versions;
  }

  for (const value of Object.values(doc.packages ?? {})) {
    const spec = Array.isArray(value) ? value[0] : value;
    if (typeof spec !== 'string') continue;
    const parsed = splitNameVersion(spec);
    if (parsed && !versions.has(parsed.name)) versions.set(parsed.name, parsed.version);
  }
  return versions;
}

/**
 * Split a `name@version` key into its parts.
 *
 * The `@` that separates them is the *last* one, because scoped packages start
 * with an `@` of their own — splitting on the first gives `('', 'scope/name@1.2.3')`.
 */
function splitNameVersion(spec: string): { name: string; version: string } | null {
  // Strip the peer annotation *first*. `react-dom@18.3.1(react@18.3.1)` records
  // which peer it resolved against, and that suffix contains an `@` of its own —
  // splitting before removing it yields the name `react-dom@18.3.1(react`.
  const base = spec.split('(')[0]?.trim() ?? '';
  const at = base.lastIndexOf('@');
  if (at <= 0) return null;
  const name = base.slice(0, at);
  const version = base.slice(at + 1);
  if (!name || !/^\d/.test(version)) return null;
  return { name, version };
}

/**
 * pnpm-lock.yaml — versions come from the `packages:` keys.
 *
 * Two key shapes are in circulation: `zod@3.25.76:` (v9 and later) and
 * `/zod/3.25.76:` (v6 and earlier). Both appear at a fixed indent under
 * `packages:`, which is enough to find them without parsing YAML.
 */
function parsePnpmLock(raw: string): Map<string, string> {
  const versions = new Map<string, string>();
  let inPackages = false;

  for (const line of raw.split('\n')) {
    if (/^[a-zA-Z]/.test(line)) inPackages = /^packages:/.test(line);
    if (!inPackages) continue;

    const key = line.match(/^\s{2}'?"?([^'":]+?)'?"?:\s*$/)?.[1];
    if (!key) continue;

    // v6: `/zod/3.25.76` or `/@scope/name/1.2.3`
    if (key.startsWith('/')) {
      const lastSlash = key.lastIndexOf('/');
      const name = key.slice(1, lastSlash);
      const version = key.slice(lastSlash + 1).split('(')[0] ?? '';
      if (name && /^\d/.test(version) && !versions.has(name)) versions.set(name, version);
      continue;
    }
    const parsed = splitNameVersion(key);
    if (parsed && !versions.has(parsed.name)) versions.set(parsed.name, parsed.version);
  }
  return versions;
}

/**
 * yarn.lock — both the classic and Berry formats.
 *
 * Classic pairs an unindented `zod@^3.24.0:` header with an indented
 * `version "3.25.76"`. Berry writes `"zod@npm:^3.24.0":` and `version: 3.25.76`.
 * Tracking the most recent header and attaching the next `version` to it handles
 * both, including the multi-descriptor headers yarn emits when several ranges
 * resolve to one package.
 */
function parseYarnLock(raw: string): Map<string, string> {
  const versions = new Map<string, string>();
  let pending: string[] = [];

  for (const line of raw.split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue;

    if (!/^\s/.test(line) && line.trimEnd().endsWith(':')) {
      // Berry opens with a `__metadata:` block that has a `version:` of its own.
      // Treating it as a package invents a dependency called `__metadata`.
      if (/^__/.test(line)) {
        pending = [];
        continue;
      }
      pending = line
        .trimEnd()
        .slice(0, -1)
        .split(',')
        .map((d) => d.trim().replace(/^"|"$/g, ''))
        .map((d) => {
          // Strip the range, keeping the name: `zod@^3.24.0` and
          // `zod@npm:^3.24.0` both name `zod`.
          const at = d.lastIndexOf('@');
          return at > 0 ? d.slice(0, at) : d;
        })
        .filter(Boolean);
      continue;
    }

    const version = line.match(/^\s+"?version"?:?\s+"?([^"\s]+)"?\s*$/)?.[1];
    if (version && pending.length > 0) {
      for (const name of pending) if (!versions.has(name)) versions.set(name, version);
      pending = [];
    }
  }
  return versions;
}

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
    // pnpm and yarn describe only which version resolved, not an install tree.
    // That is the fact the analysis actually needs; the tree only ever served as
    // a staging layout, and staging places everything flat regardless.
    for (const [file, parse] of [
      ['pnpm-lock.yaml', parsePnpmLock],
      ['yarn.lock', parseYarnLock],
      ['bun.lock', parseBunLock],
    ] as const) {
      let text: string;
      try {
        text = await readFile(path.join(repoDir, file), 'utf8');
      } catch {
        continue;
      }
      const versions = parse(text);
      if (versions.size === 0) return { ...empty, unsupported: file };
      const tree = new Map<string, LockEntry>();
      for (const [name, version] of versions) {
        const installPath = `node_modules/${name}`;
        tree.set(installPath, { name, version, installPath, dev: false });
      }
      return { versions, tree, kind: file, unsupported: null };
    }

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
