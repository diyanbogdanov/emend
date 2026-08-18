/**
 * Materialises an npm package's declared type dependencies on disk, so
 * TypeScript's own module resolver can follow declaration re-exports into them.
 *
 * Moved out of `registry.ts`, which is npm's registry *client* — fetching
 * packuments and tarballs, a concern every ecosystem shares. This file exists
 * only to satisfy `ts.createProgram`'s resolver, which is TypeScript-specific:
 * a Python or Rust adapter has no equivalent step and no reason to import it.
 */

import { readFile, mkdir, writeFile, readdir, symlink, access } from 'node:fs/promises';
import path from 'node:path';
import { fetchPackument, fetchPackageDir, resolveRange, packageNameOfSpecifier } from '../registry.ts';

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
 * The common shape is shallow — a facade package over a core package, which may
 * itself reference one shared types package — but real chains run deeper, and a
 * depth that stops short reports a hollow surface as "ships no type
 * declarations". The file and total caps below are what actually bound the
 * work. Raise the depth if you see hollow surfaces; the cost is roughly linear
 * in packages fetched.
 */
const TYPE_DEP_DEPTH = 6;
const TYPE_DEP_FILE_CAP = 4000;
const TYPE_DEP_TOTAL_CAP = 500;

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

// Duplicated rather than imported from `registry.ts`: every file in this
// codebase that needs an existence check (inventory.ts, apply.ts, verify.ts,
// cli.ts, vendor.ts, registry.ts) defines its own private copy rather than
// sharing one, and this file follows that convention instead of forking it.
async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Expose an already-extracted cache directory at a second path.
 *
 * A symlink is enough for TypeScript, and the same cached tarball is referenced
 * from many packages' node_modules — a real copy would multiply disk use by the
 * number of dependents.
 */
async function linkTree(from: string, to: string): Promise<void> {
  if (await exists(to)) return;
  await mkdir(path.dirname(to), { recursive: true });
  await symlink(from, to, 'dir');
}
