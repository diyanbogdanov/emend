/**
 * Locates where a Python repository actually uses symbols from tracked
 * packages — `callsites.ts`'s question, answered off a tree-sitter parse
 * instead of a type checker, because Python has no compiler API embedded here
 * the way TypeScript is one.
 *
 * That difference is not cosmetic — it is a difference in what this module
 * can actually prove, and a reader must not assume parity with the
 * TypeScript resolver just because both return `CallSite[]`:
 *
 * - **The import is the precondition.** Without an import there is no path to
 *   the symbol, whatever names appear in the file — so "not imported from
 *   this repository's source" is a claim this module can make honestly, the
 *   same load-bearing negative `callsites.ts`'s own doc describes.
 * - **A bare function is exact.** `from requests import send` fixes what a
 *   later `send(...)` refers to; `import requests as r` fixes what `r.send(...)`
 *   refers to. Either way there is only one thing the call can mean.
 * - **A method is not.** `c.close()` is only a call to the tracked symbol if
 *   `c` is an instance of the right class, and knowing that needs a type
 *   checker Python does not have here. So a method match says *a call to a
 *   method of this name appears here, in a file that imports the affected
 *   module* — a strong lead, not proof.
 *
 * This is the same position a now-deleted Go resolver took, for the same
 * reason (`git show af85545~1:src/goreach.ts` — Go's compiler API is not
 * embedded here either): every site this module finds carries `via:
 * 'import'`, never `via: 'type'`, because nothing here ever resolves a
 * receiver's type.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Node, Tree } from 'web-tree-sitter';
import { parsePython } from './parser.ts';
import { walkDir, type CallSiteIndex } from '../callsites.ts';
import type { ApiSurface, CallSite } from '../types.ts';

const PY_EXTENSIONS = ['.py', '.pyi'];

/**
 * Path segments that hold a *dependency's* Python source, never this
 * repository's own — a virtual environment, or a tool's cache of one.
 * `walkDir` (callsites.ts) skips the same names for the same reason, kept as
 * its own list there rather than imported from here — see its comment for
 * why. Without this, a repository with `.venv/` checked out in place (the
 * default location `python -m venv .venv` puts it) would have its call-site
 * search walk into a vendored copy of the very package being tracked, and
 * report that package's own internals as this repository's call sites.
 * `.tox` and `.nox` are the same risk for tox's and nox's own per-run
 * environments; `envs` is conda's directory of named environments (`conda
 * create -p ./envs/name`).
 *
 * `env` is deliberately not in this set, unlike every name above. It is a
 * plausible real source directory (`src/env/config.py`) in a way `.venv` or
 * `__pycache__` never are, so a blind name match would silently hide real
 * call sites in any repository that happens to have a package called `env` —
 * worse than the problem this set exists to fix. `isVendored` below instead
 * treats a bare `env` segment as a virtual environment only when `pyvenv.cfg`
 * — the marker `venv`/`virtualenv` write at an environment's root (PEP 405)
 * — actually sits beside it.
 */
const VENDORED_DIR = new Set([
  '.venv',
  'venv',
  '__pycache__',
  'site-packages',
  '.tox',
  '.nox',
  'envs',
]);

function isVendored(absPath: string): boolean {
  const segments = absPath.split(path.sep);
  for (const [i, segment] of segments.entries()) {
    if (segment === 'env') {
      if (existsSync(path.join(segments.slice(0, i + 1).join(path.sep), 'pyvenv.cfg'))) return true;
      continue;
    }
    if (VENDORED_DIR.has(segment)) return true;
  }
  return false;
}

/**
 * What one file's imports bind, split by how a later reference resolves
 * through them.
 */
interface Imports {
  /** Local name -> module dotted path, from `import x` / `import x as y`. A
   *  reference through one of these is a qualified call: `alias.symbol(...)`. */
  modules: Map<string, string>;
  /** Local name -> where it came from, from `from x import a [as b]`. A
   *  reference through one of these is a bare call: `symbol(...)`. */
  names: Map<string, { module: string; exported: string }>;
  /** Modules reached through `from x import *`. Every one of that module's
   *  exports is bound bare under its own name — with no `names` entry to
   *  point at, since the module's actual export list is never read — so a
   *  bare call matching a wanted symbol's own name is enough. */
  starImported: Set<string>;
  /** Every module dotted path named by *any* import statement, in any form.
   *  The precondition for method-name matching: resolving the receiver of
   *  `c.close()` needs a type checker Python does not have here, so the file
   *  having imported the module at all is the strongest fact available. */
  referenced: Set<string>;
}

/**
 * Walks the whole tree — not just top-level statements — because Python
 * imports legally appear inside `if TYPE_CHECKING:`, `try/except`, and
 * function bodies, and a conditional import is still an import.
 */
function collectImports(root: Node): Imports {
  const modules = new Map<string, string>();
  const names = new Map<string, { module: string; exported: string }>();
  const starImported = new Set<string>();
  const referenced = new Set<string>();

  const visit = (node: Node): void => {
    if (node.type === 'import_statement') {
      for (const child of node.namedChildren) {
        if (child.type === 'dotted_name') {
          const modulePath = child.text;
          // `import a.b.c` binds only the first segment (`a`) in the local
          // scope; the rest is reached through attribute access on it, not
          // through a second name. An aliased import (below) has no such
          // wrinkle — the alias always names the whole dotted path.
          const local = child.namedChild(0)?.text ?? modulePath;
          modules.set(local, modulePath);
          referenced.add(modulePath);
        } else if (child.type === 'aliased_import') {
          const modulePath = child.childForFieldName('name')?.text;
          const alias = child.childForFieldName('alias')?.text;
          if (modulePath && alias) {
            modules.set(alias, modulePath);
            referenced.add(modulePath);
          }
        }
      }
    } else if (node.type === 'import_from_statement') {
      const moduleNode = node.childForFieldName('module_name');
      // A relative import (`from . import x`, `from .sub import x`) names a
      // module inside this same repository, never an external dependency —
      // it cannot resolve to a tracked package and is left unrecorded rather
      // than guessed at.
      if (moduleNode?.type === 'dotted_name') {
        const modulePath = moduleNode.text;
        referenced.add(modulePath);
        for (const child of node.namedChildren) {
          if (child === moduleNode) continue;
          if (child.type === 'wildcard_import') {
            starImported.add(modulePath);
          } else if (child.type === 'dotted_name') {
            names.set(child.text, { module: modulePath, exported: child.text });
          } else if (child.type === 'aliased_import') {
            const exported = child.childForFieldName('name')?.text;
            const alias = child.childForFieldName('alias')?.text;
            if (exported && alias) names.set(alias, { module: modulePath, exported });
          }
        }
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);

  return { modules, names, starImported, referenced };
}

/**
 * Whether `modulePath` is `pkg` itself or one of its submodules — matched on
 * whole path segments, never a string prefix: `pkg.startsWith('requests')`
 * would wrongly claim `requests_toolbelt` and `requestsauth` as part of
 * `requests`. Every import form funnels through this one check, so `from
 * pkg.sub import Name` is recognised exactly where `from pkg import Name`
 * already was.
 */
function belongsToPackage(modulePath: string, pkg: string): boolean {
  return modulePath === pkg || modulePath.startsWith(`${pkg}.`);
}

/**
 * The module a qualified call's receiver names, when that receiver is an
 * import binding at all.
 *
 * One hop covers the common case: `r` in `r.send(...)` resolves straight
 * through `imports.modules`, whether that came from `import requests as r`
 * or plain `import requests`. A submodule imported without an alias needs a
 * second shape: `import werkzeug.datastructures` binds only the top-level
 * name `werkzeug`, not `werkzeug.datastructures` — Python has no name bound
 * to the submodule itself — so the symbol is reached as
 * `werkzeug.datastructures.Headers(...)`, where the receiver is a two-level
 * attribute chain (an `attribute` node, not an `identifier`). That chain
 * resolves only when it exactly matches what was imported, because there is
 * no shorthand for reaching a submodule this way: nothing shorter, nothing
 * renamed.
 *
 * Anything else — a local variable, a function's return value — is not an
 * import binding and yields undefined, same as before this function existed.
 */
function receiverModule(object: Node | null, imports: Imports): string | undefined {
  if (!object) return undefined;
  if (object.type === 'identifier') return imports.modules.get(object.text);
  if (object.type !== 'attribute') return undefined;
  // `object.text` is the exact source slice for this node, e.g.
  // "werkzeug.datastructures" — already the literal dotted path, the same
  // way `collectImports` reads a `dotted_name`'s `.text` for the same reason.
  const text = object.text;
  const dot = text.indexOf('.');
  const root = dot === -1 ? text : text.slice(0, dot);
  const bound = imports.modules.get(root);
  return bound === text ? bound : undefined;
}

/**
 * One file's call sites for `pkg`'s tracked `symbols`, bucketed by the exact
 * canonical path each site matched — the shape `findPythonCallSites` needs to
 * assemble `CallSiteIndex.byPackage` from one parse of one file, whatever
 * `symbols` contains (convention: read and parse each file once, never once
 * per wanted symbol). `pythonSites` below flattens this same result for its
 * own simpler, per-file contract.
 */
function bucketedSites(
  root: Node,
  source: string,
  file: string,
  pkg: string,
  symbols: string[],
): Map<string, CallSite[]> {
  const buckets = new Map<string, CallSite[]>();
  const imports = collectImports(root);
  const lines = source.split('\n');

  // Split once: a bare symbol (`send`) is matched through a binding — a
  // from-import or a module alias; a dotted symbol (`Session.close`) is
  // matched by its method name alone, wherever that name is called.
  const bareWanted = new Set(symbols.filter((s) => !s.includes('.')));
  const methodWanted = new Map<string, string>(); // method name -> canonical path
  for (const s of symbols) {
    const dot = s.indexOf('.');
    if (dot !== -1) methodWanted.set(s.slice(dot + 1), s);
  }

  // Computed once per file/package pair, not per call site: whether *any*
  // star import or *any* referenced module belongs to `pkg`, so `from
  // pkg.sub import *` and a method lead through `from pkg.sub import Name`
  // get the same submodule treatment as their flat forms.
  const starImportsPkg = [...imports.starImported].some((m) => belongsToPackage(m, pkg));
  const referencesPkg = [...imports.referenced].some((m) => belongsToPackage(m, pkg));

  const record = (canonical: string, at: Node): void => {
    const { row, column } = at.startPosition;
    const list = buckets.get(canonical) ?? [];
    list.push({
      file,
      line: row + 1,
      column: column + 1,
      text: (lines[row] ?? '').trim().slice(0, 120),
      via: 'import',
    });
    buckets.set(canonical, list);
  };

  const visit = (node: Node): void => {
    if (node.type === 'call') {
      const fn = node.childForFieldName('function');
      if (fn?.type === 'identifier') {
        // A bare call: `send(...)`. Resolved through a from-import binding,
        // or — if the module was star-imported — through its own name,
        // since a star import binds every export bare under that name.
        const local = fn.text;
        const binding = imports.names.get(local);
        const resolved =
          binding && belongsToPackage(binding.module, pkg)
            ? binding.exported
            : starImportsPkg
              ? local
              : undefined;
        if (resolved !== undefined && bareWanted.has(resolved)) record(resolved, fn);
      } else if (fn?.type === 'attribute') {
        const object = fn.childForFieldName('object');
        const member = fn.childForFieldName('attribute')?.text;
        if (member) {
          // A qualified call through a known import binding: `r.send(...)`
          // after `import requests as r`, or the literal chain
          // `werkzeug.datastructures.Headers(...)` after the unaliased
          // `import werkzeug.datastructures` — see `receiverModule`. Exact —
          // the binding is proof the receiver *is* the module, so `member`
          // is one of its top-level exports, not a guess about some
          // unrelated object's own method.
          const resolvedModule = receiverModule(object, imports);
          if (resolvedModule && belongsToPackage(resolvedModule, pkg) && bareWanted.has(member)) {
            record(member, fn);
          }
          // A method-style match: `.member(...)` on whatever the receiver
          // is. This cannot be resolved further without a type checker — see
          // the module doc — so it matches by name alone, gated on the file
          // importing the module (or one of its submodules) at all.
          const canonical = methodWanted.get(member);
          if (canonical && referencesPkg) record(canonical, fn);
        }
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);

  return buckets;
}

/**
 * One file's call sites for `pkg`'s tracked `symbols`. The per-file worker
 * `findPythonCallSites` is built on; exported (only) so tests can exercise
 * file-level matching without assembling a repository walk.
 */
export async function pythonSites(
  file: string,
  source: string,
  pkg: string,
  symbols: string[],
): Promise<CallSite[]> {
  const tree = await parsePython(source);
  return [...bucketedSites(tree.rootNode, source, file, pkg, symbols).values()].flat();
}

/**
 * `CallSiteResolver.find` for Python: walks `repoDir`'s `.py`/`.pyi` files,
 * parsing each one once and matching every tracked package's wanted symbols
 * against that single parse, then assembles the same `CallSiteIndex` shape
 * `findCallSites` (callsites.ts) returns for TypeScript.
 *
 * Async, unlike `findCallSites`: `parsePython` loads a WASM grammar, which
 * `web-tree-sitter` only offers an async API for. See the widened return type
 * on `CallSiteResolver.find` (callsites.ts) for how the seam accommodates
 * both shapes without forcing either resolver into the other's.
 */
export async function findPythonCallSites(
  repoDir: string,
  surfaces: Map<string, ApiSurface>,
  wanted: Map<string, Set<string>>,
): Promise<CallSiteIndex> {
  const warnings: string[] = [];
  const byPackage = new Map<string, Map<string, CallSite[]>>();
  for (const pkg of surfaces.keys()) byPackage.set(pkg, new Map());

  const repoAbs = path.resolve(repoDir);
  const files = walkDir(repoAbs, PY_EXTENSIONS).filter((f) => !isVendored(f));
  let filesAnalyzed = 0;

  for (const abs of files) {
    let source: string;
    try {
      source = await readFile(abs, 'utf8');
    } catch {
      continue;
    }
    filesAnalyzed++;

    let tree: Tree;
    try {
      tree = await parsePython(source);
    } catch (err) {
      warnings.push(`could not parse ${path.relative(repoAbs, abs)}: ${(err as Error).message}`);
      continue;
    }

    const rel = path.relative(repoAbs, abs).split(path.sep).join('/');
    for (const [pkg, symbolSet] of wanted) {
      const bucket = byPackage.get(pkg);
      if (!bucket || symbolSet.size === 0) continue;
      const found = bucketedSites(tree.rootNode, source, rel, pkg, [...symbolSet]);
      for (const [canonical, sites] of found) {
        const existing = bucket.get(canonical) ?? [];
        existing.push(...sites);
        bucket.set(canonical, existing);
      }
    }
  }

  return { byPackage, filesAnalyzed, warnings };
}
