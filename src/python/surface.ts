/**
 * Extracts the public API surface of a Python package by parsing its source
 * with tree-sitter and reading module- and class-level definitions directly
 * off the syntax tree — the same role `surface.ts` plays for TypeScript, but
 * off source instead of off a checker, because Python has no `.d.ts`
 * equivalent and no bundled checker to ask.
 *
 * That difference is the whole shape of this module's limits, stated here
 * rather than scattered through the walk:
 *
 * - No type inference. A symbol's signature is whatever its own `def` line
 *   says, verbatim. Nothing resolves what a name refers to.
 * - Re-exports through `__init__.py` are invisible. `from .api import get`
 *   is an `import_from_statement`, not a definition, so it produces no
 *   symbol of its own — this module never follows it back to where `get` is
 *   actually defined. See `walkModule`'s file-merging strategy below for how
 *   that gap is papered over well enough to be useful anyway.
 * - `__getattr__`-based dynamic module exports (PEP 562) are invisible —
 *   there is no assignment or `def` for a name that is manufactured at
 *   import time.
 * - A decorator that rewrites what callers actually pass — `click.command()`
 *   turning a function into a CLI object, or a `functools.wraps` wrapper
 *   with a different real signature — is read at its face-value `def` line,
 *   not its effective one. Only `@deprecated` is special-cased at all (see
 *   `unwrapDecorated`).
 *
 * `.pyi` stub files are walked exactly like `.py` files, deliberately not
 * preferred over them the way `surface.ts` prefers `.d.ts` over `.js`.
 * Preferring a stub correctly would mean pairing each `.pyi` with the `.py`
 * of the same module rather than just merging every file's top-level names
 * (see below), which is real work with no evidence yet that it matters —
 * inline stubs shipped alongside their own implementation are rare in
 * published wheels. Both extensions are read; where a package ships both for
 * one module, whichever file this walk reads first wins, by plain
 * alphabetical order — `.py` before `.pyi`.
 *
 * `byTypeMember` and `aliases` are always empty. Both exist on `ApiSurface`
 * to answer questions only a type checker can: which declaration a value's
 * type resolves to, and which other paths reach the same symbol. Nothing
 * here plays that role for Python, so both stay the empty maps they were
 * declared with rather than going unset.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Node } from 'web-tree-sitter';
import { parsePython } from './parser.ts';
import type { ApiSurface, ApiSymbol } from '../types.ts';

const PY_SOURCE = /\.pyi?$/;

/** Directories under an extracted wheel that never hold package source. */
function isSkippedDir(name: string): boolean {
  return name === '__pycache__' || name.startsWith('.') || /\.(dist-info|data)$/.test(name);
}

/** Every `.py`/`.pyi` file under `dir`, relative to it, in a stable order. */
async function collectPySources(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(path.join(dir, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!isSkippedDir(entry.name)) await walk(rel);
      } else if (entry.isFile() && PY_SOURCE.test(entry.name)) {
        found.push(rel);
      }
    }
  };
  await walk('');
  return found.sort();
}

/**
 * `SurfaceExtractor.extract` for PyPI: reads every `.py`/`.pyi` file under an
 * already-downloaded package directory and delegates to `surfaceFromSource`.
 */
export async function extractPythonSurface(
  pkgDir: string,
  pkg: string,
  version: string,
): Promise<ApiSurface> {
  const relPaths = await collectPySources(pkgDir);
  const files: Record<string, string> = {};
  for (const rel of relPaths) {
    files[rel] = await readFile(path.join(pkgDir, rel), 'utf8');
  }
  return surfaceFromSource(pkg, version, files);
}

/**
 * Does the actual extraction work, from an in-memory path -> source map
 * rather than a directory — exported so it can be tested without downloading
 * a wheel (`extractPythonSurface` is the real entry point; it just reads
 * files into this same shape and calls through).
 *
 * Every file's top-level definitions are merged into one flat namespace, with
 * no per-file prefix: a consumer overwhelmingly imports `pkg.get`, not
 * `pkg.api.get`, and without following `__init__.py`'s re-exports (this
 * module does not — see the module doc) treating each file as its own
 * namespace would report a removal and an addition every time a package
 * moved a function between internal files, which is noise of exactly the
 * kind `surface.ts` strips cache paths to avoid on the TypeScript side. The
 * cost is the reverse case: two files that happen to define the same
 * top-level name collide, and the one read first (alphabetical path order)
 * wins silently.
 */
export async function surfaceFromSource(
  pkg: string,
  version: string,
  files: Record<string, string>,
): Promise<ApiSurface> {
  const paths = Object.keys(files).sort();
  const symbols: Record<string, ApiSymbol> = {};

  for (const filePath of paths) {
    const source = files[filePath];
    if (source === undefined) continue;
    const tree = await parsePython(source);
    walkModule(tree.rootNode, symbols);
  }

  // No readable source is not an empty API — it is a walk that never ran.
  // Reporting it as "analyzed, zero symbols" would diff as "nothing changed",
  // which renders as a clean upgrade — the most dangerous wrong answer this
  // tool can give. `entry: null` is what tells `diffSurfaces` to say
  // `unanalyzable` instead, exactly as it does for a TypeScript package that
  // ships no declarations.
  if (Object.keys(symbols).length === 0) {
    return {
      pkg,
      version,
      symbols: {},
      byTypeMember: {},
      aliases: {},
      entry: null,
      note:
        paths.length === 0
          ? `no Python source was found for ${pkg}@${version}`
          : `${paths.length} Python file(s) were read for ${pkg}@${version} but no public symbols were found in them`,
    };
  }

  return {
    pkg,
    version,
    symbols,
    byTypeMember: {},
    aliases: {},
    // Python has no single entry point the way a resolved `.d.ts` is one; the
    // first file read stands in as a representative, non-null pointer. Only
    // its nullness is ever inspected (see `diffSurfaces`).
    entry: paths[0] ?? null,
  };
}

/**
 * Whether a module-level name belongs in the surface. `__all__`, when the
 * module declares one, is the module's own statement of what it exports —
 * honouring the leading-underscore convention over it would substitute a
 * guess for a fact the module already states. Absent `__all__`, the
 * convention is all there is.
 */
function isPublic(name: string, exported: string[] | undefined): boolean {
  return exported ? exported.includes(name) : !name.startsWith('_');
}

/**
 * `__all__`'s string entries, when the module declares one at the top level.
 * A list or a tuple literal both hold `string` children the same way, so
 * either is read without needing to tell them apart.
 */
function readDunderAll(root: Node): string[] | undefined {
  for (const stmt of root.namedChildren) {
    if (stmt.type !== 'expression_statement') continue;
    const assign = stmt.namedChild(0);
    if (assign?.type !== 'assignment') continue;
    if (assign.childForFieldName('left')?.text !== '__all__') continue;
    const right = assign.childForFieldName('right');
    if (!right) continue;
    return right.namedChildren.filter((c) => c.type === 'string').map(stringContent);
  }
  return undefined;
}

/** A string node's literal content, quotes stripped. */
function stringContent(str: Node): string {
  return str.namedChildren
    .filter((c) => c.type === 'string_content')
    .map((c) => c.text)
    .join('');
}

/** Module-level statements: functions, classes, and typed assignments. */
function walkModule(root: Node, symbols: Record<string, ApiSymbol>): void {
  const exported = readDunderAll(root);
  for (const stmt of root.namedChildren) {
    const { node: target, deprecated } = unwrapDecorated(stmt);

    if (target.type === 'function_definition') {
      const name = target.childForFieldName('name')?.text;
      if (name && isPublic(name, exported)) {
        recordFunction(target, name, '', 'function', deprecated, symbols);
      }
    } else if (target.type === 'class_definition') {
      const name = target.childForFieldName('name')?.text;
      if (name && isPublic(name, exported)) recordClass(target, name, deprecated, symbols);
    } else if (target.type === 'expression_statement') {
      const info = variableInfo(target);
      if (info && isPublic(info.name, exported)) {
        symbols[info.name] = variableSymbol(info);
      }
    }
  }
}

/**
 * A class body's statements: methods, and typed attribute assignments.
 *
 * No privacy filtering here, unlike `walkModule`. `__init__` and every other
 * dunder method start with an underscore and are exactly the signatures this
 * tool most needs to see — a constructor gaining a required parameter is a
 * textbook breaking change — and `__all__`, the module-level rule's only
 * override, never lists a dotted member path in the first place. A nested
 * `class_definition` here is not walked; the spec this module implements
 * calls only for recursing into a class body to find methods.
 */
function walkClassBody(body: Node, className: string, symbols: Record<string, ApiSymbol>): void {
  for (const stmt of body.namedChildren) {
    const { node: target, deprecated } = unwrapDecorated(stmt);
    if (target.type === 'function_definition') {
      const name = target.childForFieldName('name')?.text;
      if (name) recordFunction(target, name, className, 'method', deprecated, symbols);
    } else if (target.type === 'expression_statement') {
      const info = variableInfo(target);
      if (info) {
        const symPath = `${className}.${info.name}`;
        symbols[symPath] = variableSymbol(info, symPath);
      }
    }
  }
}

function recordFunction(
  node: Node,
  name: string,
  prefix: string,
  kind: 'function' | 'method',
  deprecated: boolean,
  symbols: Record<string, ApiSymbol>,
): void {
  const symPath = prefix ? `${prefix}.${name}` : name;
  const doc = deprecated ? firstDocstring(node.childForFieldName('body')) : undefined;
  symbols[symPath] = {
    path: symPath,
    kind,
    signature: buildFunctionSignature(node),
    deprecated,
    ...(doc ? { doc } : {}),
    optional: false,
  };
}

function recordClass(
  node: Node,
  name: string,
  deprecated: boolean,
  symbols: Record<string, ApiSymbol>,
): void {
  const doc = deprecated ? firstDocstring(node.childForFieldName('body')) : undefined;
  symbols[name] = {
    path: name,
    kind: 'class',
    // A class carries no call signature of its own here — `__init__` is
    // walked as `ClassName.__init__` like any other method, which is where a
    // constructor's real parameter list lives.
    signature: '',
    deprecated,
    ...(doc ? { doc } : {}),
    optional: false,
  };
  const body = node.childForFieldName('body');
  if (body) walkClassBody(body, name, symbols);
}

function variableSymbol(info: { name: string; type: string }, symPath = info.name): ApiSymbol {
  return { path: symPath, kind: 'variable', signature: info.type, deprecated: false, optional: false };
}

/**
 * `x: int` (with or without a value) — an `expression_statement` wrapping an
 * `assignment` that carries a `type` field. Untyped assignments (`y = 5`)
 * are not a declared contract the way an annotation is, and are left alone.
 */
function variableInfo(stmt: Node): { name: string; type: string } | undefined {
  const assign = stmt.namedChild(0);
  if (assign?.type !== 'assignment') return undefined;
  const typeNode = assign.childForFieldName('type');
  const nameNode = assign.childForFieldName('left');
  if (!typeNode || nameNode?.type !== 'identifier') return undefined;
  return { name: nameNode.text, type: typeNode.text };
}

/**
 * Peels a `decorated_definition` down to the function or class it wraps, and
 * whether `@deprecated` is among its decorators. Returns `stmt` itself,
 * un-deprecated, when it isn't a `decorated_definition` at all.
 */
function unwrapDecorated(stmt: Node): { node: Node; deprecated: boolean } {
  if (stmt.type !== 'decorated_definition') return { node: stmt, deprecated: false };
  const deprecated = stmt.namedChildren
    .filter((c) => c.type === 'decorator')
    .some(isDeprecatedDecorator);
  return { node: stmt.childForFieldName('definition') ?? stmt, deprecated };
}

function isDeprecatedDecorator(decorator: Node): boolean {
  const expr = decorator.namedChild(0);
  return expr !== null && decoratorCalleeName(expr) === 'deprecated';
}

/** The name a decorator invokes, however it's spelled: `@deprecated`, `@deprecated(...)`, or `@typing_extensions.deprecated(...)`. */
function decoratorCalleeName(expr: Node): string | undefined {
  if (expr.type === 'identifier') return expr.text;
  if (expr.type === 'attribute') return expr.childForFieldName('attribute')?.text;
  if (expr.type === 'call') {
    const fn = expr.childForFieldName('function');
    return fn ? decoratorCalleeName(fn) : undefined;
  }
  return undefined;
}

/**
 * The body's first statement, when it is a bare string literal — Python's
 * docstring convention. Captured only for deprecated symbols, matching what
 * `surface.ts` does for TypeScript's `@deprecated` and for the same reason:
 * a deprecation usually says what to use instead, and every other symbol's
 * docstring is not a migration instruction worth spending the surface on.
 */
function firstDocstring(body: Node | null): string | undefined {
  const first = body?.namedChildren[0];
  if (first?.type !== 'expression_statement') return undefined;
  const str = first.namedChild(0);
  if (str?.type !== 'string') return undefined;
  const text = stringContent(str).trim();
  return text || undefined;
}

function buildFunctionSignature(fn: Node): string {
  const params = fn.childForFieldName('parameters');
  const paramList = params ? buildParameterList(params) : '()';
  const returnType = fn.childForFieldName('return_type');
  return returnType ? `${paramList} -> ${returnType.text}` : paramList;
}

/**
 * The parameter list's own source text, `self`/`cls` dropped. They name the
 * receiver, not part of what a caller supplies — keeping them would make
 * every method signature disagree with how it's actually called.
 */
function buildParameterList(params: Node): string {
  const parts: string[] = [];
  for (const child of params.namedChildren) {
    const name = parameterName(child);
    if (name === 'self' || name === 'cls') continue;
    parts.push(child.text);
  }
  return `(${parts.join(', ')})`;
}

/**
 * A parameter node's own name, for the `self`/`cls` check only — never for
 * display, since `child.text` (what's actually shown) already includes any
 * annotation and default. `*`/`/` separators and splats never equal `self`
 * or `cls`, so they fall through to `undefined` and are always kept.
 */
function parameterName(param: Node): string | undefined {
  if (param.type === 'identifier') return param.text;
  if (param.type === 'typed_parameter') {
    // The identifier (or splat pattern) is the first child and carries no
    // field name of its own — only `type:` is a named field here.
    const inner = param.namedChild(0);
    return inner?.type === 'identifier' ? inner.text : undefined;
  }
  if (param.type === 'default_parameter' || param.type === 'typed_default_parameter') {
    return param.childForFieldName('name')?.text;
  }
  return undefined;
}
