/**
 * Extracts the public API surface of a package from its TypeScript declarations.
 *
 * This is Emend's primary change source. Nearly every modern npm SDK ships
 * `.d.ts` files, they are versioned alongside the code, and they describe the
 * exact surface consumers can touch — which makes them a far better contract
 * than a changelog and available without any provider cooperation.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import type { ApiSurface, ApiSymbol, SymbolKind } from './types.ts';

/** Bounds on the walk. Deep SDK surfaces would otherwise expand without limit. */
const MAX_DEPTH = 4;
const MAX_SYMBOLS = 25000;
const MAX_SIGNATURE_CHARS = 4000;

interface PackageJson {
  name?: string;
  version?: string;
  types?: string;
  typings?: string;
  main?: string;
  exports?: unknown;
}

/**
 * Resolve the `.d.ts` entry point for a package directory.
 * Returns null when the package ships no types — which the caller must treat as
 * "unanalyzable", never as "no changes".
 */
export async function resolveTypesEntry(pkgDir: string): Promise<string | null> {
  let manifest: PackageJson;
  try {
    manifest = JSON.parse(
      await readFile(path.join(pkgDir, 'package.json'), 'utf8'),
    ) as PackageJson;
  } catch {
    return null;
  }

  const candidates: string[] = [];
  const push = (rel: unknown) => {
    if (typeof rel === 'string' && rel.length > 0) candidates.push(rel);
  };

  push(manifest.types);
  push(manifest.typings);

  // `exports` may nest the types condition arbitrarily; collect every `types`
  // string reachable under the root export.
  const root = readExportsRoot(manifest.exports);
  collectTypesConditions(root, push);

  // Conventional fallbacks, including the `main.js` -> `main.d.ts` convention.
  if (typeof manifest.main === 'string') {
    push(manifest.main.replace(/\.(c|m)?js$/, '.d.ts'));
  }
  push('index.d.ts');
  push('dist/index.d.ts');
  push('lib/index.d.ts');
  push('types/index.d.ts');

  for (const rel of candidates) {
    const abs = path.resolve(pkgDir, rel);
    if (!abs.endsWith('.d.ts') && !abs.endsWith('.d.mts') && !abs.endsWith('.d.cts')) {
      // A `types` field occasionally points at a directory or a .ts source.
      for (const suffix of ['.d.ts', '/index.d.ts']) {
        if (ts.sys.fileExists(abs + suffix)) return abs + suffix;
      }
      if (ts.sys.fileExists(abs)) return abs;
      continue;
    }
    if (ts.sys.fileExists(abs)) return abs;
  }
  return null;
}

function readExportsRoot(exports: unknown): unknown {
  if (exports && typeof exports === 'object' && !Array.isArray(exports)) {
    const obj = exports as Record<string, unknown>;
    if ('.' in obj) return obj['.'];
  }
  return exports;
}

function collectTypesConditions(node: unknown, push: (v: unknown) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectTypesConditions(item, push);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (typeof obj['types'] === 'string') push(obj['types']);
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'types') continue;
    collectTypesConditions(value, push);
  }
}

function kindOf(flags: ts.SymbolFlags): SymbolKind {
  if (flags & ts.SymbolFlags.Class) return 'class';
  if (flags & ts.SymbolFlags.Interface) return 'interface';
  if (flags & ts.SymbolFlags.TypeAlias) return 'type';
  if (flags & ts.SymbolFlags.Enum) return 'enum';
  if (flags & ts.SymbolFlags.Method) return 'method';
  if (flags & ts.SymbolFlags.Function) return 'function';
  if (flags & ts.SymbolFlags.Property) return 'property';
  if (flags & (ts.SymbolFlags.Variable | ts.SymbolFlags.BlockScopedVariable)) {
    return 'variable';
  }
  return 'unknown';
}

/**
 * Normalise a type string so that cosmetic differences between two published
 * versions do not register as API changes.
 *
 * `import("/abs/path/to/pkg/dist/foo").Bar` is the same API as
 * `import("/other/cache/path").Bar` — the absolute paths differ only because the
 * two versions were extracted to different cache directories. Without this,
 * essentially every symbol would look "changed".
 */
export function normaliseSignature(raw: string): string {
  let s = raw.replace(/import\((?:"[^"]*"|'[^']*')\)\./g, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > MAX_SIGNATURE_CHARS) {
    s = s.slice(0, MAX_SIGNATURE_CHARS) + '…<truncated>';
  }
  return s;
}

function isDeprecated(sym: ts.Symbol, checker: ts.TypeChecker): boolean {
  try {
    return sym.getJsDocTags(checker).some((t: ts.JSDocTagInfo) => t.name === 'deprecated');
  } catch {
    return false;
  }
}

/**
 * True when a symbol comes from TypeScript's own lib files (Array, Promise,
 * Number, ...). These are JavaScript built-ins, never part of a package's API
 * contract.
 *
 * Filtering them is not cosmetic. Without it, a single exported array constant
 * drags in every `Array` member, then every `Number` member from `.length`, and
 * the walk exhausts its symbol budget on `EMPTY_PATH.length.toString`. A
 * truncated surface then makes real symbols look deleted.
 */
function isLibSymbol(sym: ts.Symbol): boolean {
  const decls = sym.declarations;
  if (!decls || decls.length === 0) return false;
  return decls.every((d) => {
    const f = d.getSourceFile().fileName;
    return /[\\/]typescript[\\/]lib[\\/]lib\..*\.d\.ts$/.test(f) || /[\\/]lib\.[a-z0-9.]*d\.ts$/.test(f);
  });
}

/** True when every declaration of a symbol lives inside the package directory. */
function declaredInPackage(sym: ts.Symbol, pkgDirNormalised: string): boolean {
  const decls = sym.declarations;
  if (!decls || decls.length === 0) return false;
  return decls.some((d) =>
    d.getSourceFile().fileName.replace(/\\/g, '/').startsWith(pkgDirNormalised),
  );
}

/**
 * Build the API surface for an already-extracted package directory.
 *
 * Missing transitive dependencies are expected and fine: unresolved imports
 * degrade to `any`, which affects a handful of signatures but never prevents the
 * walk. We are diffing a surface against itself across versions, so both sides
 * degrade identically.
 */
export async function extractSurface(
  pkgDir: string,
  pkg: string,
  version: string,
): Promise<ApiSurface> {
  const entry = await resolveTypesEntry(pkgDir);
  if (!entry) {
    return {
      pkg,
      version,
      symbols: {},
      byTypeMember: {},
      aliases: {},
      entry: null,
      note: 'package ships no TypeScript declarations',
    };
  }

  const program = ts.createProgram([entry], {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    skipDefaultLibCheck: true,
    noResolve: false,
    allowJs: false,
    declaration: false,
    strict: false,
  });

  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  if (!source) {
    return {
      pkg,
      version,
      symbols: {},
      byTypeMember: {},
      aliases: {},
      entry,
      note: 'TypeScript could not load the declaration entry point',
    };
  }

  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) {
    return {
      pkg,
      version,
      symbols: {},
      byTypeMember: {},
      aliases: {},
      entry,
      note: 'declaration entry point exports nothing resolvable',
    };
  }

  const symbols: Record<string, ApiSymbol> = {};
  const byTypeMember: Record<string, string> = {};
  const aliases: Record<string, string> = {};
  const pkgDirNormalised = path.resolve(pkgDir).replace(/\\/g, '/');
  let truncated = false;

  /**
   * Symbol -> the one path it is recorded under.
   *
   * A symbol is reachable by many paths (`ZodError.errors` and
   * `ZodInvalidArgumentsIssue.argumentsError.errors` are the same member).
   * Recording it once keeps the surface proportional to the API rather than to
   * the number of routes through it — recording every path ballooned zod 4 from
   * ~8k to ~25k symbols and blew the budget.
   *
   * Claimed at *enqueue* time, so that when two parents reference the same
   * child, the first claim wins rather than whichever is dequeued first.
   */
  const claimed = new Map<ts.Symbol, string>();

  interface QueueItem {
    sym: ts.Symbol;
    path: string;
    depth: number;
  }
  const queue: QueueItem[] = [];

  const resolveAlias = (sym: ts.Symbol): ts.Symbol => {
    if (sym.flags & ts.SymbolFlags.Alias) {
      try {
        return checker.getAliasedSymbol(sym);
      } catch {
        return sym;
      }
    }
    return sym;
  };

  /**
   * Claim a path for a symbol and schedule it. Returns the canonical path, which
   * is the already-claimed one if this symbol was seen at a shallower depth.
   */
  const enqueue = (sym: ts.Symbol, symPath: string, depth: number): string | null => {
    if (depth > MAX_DEPTH) return null;
    if (isLibSymbol(sym)) return null;
    const resolved = resolveAlias(sym);
    const existing = claimed.get(resolved);
    if (existing !== undefined) {
      // Same symbol, different route. Remember the route so call-site matching
      // can resolve whichever spelling the source actually used.
      if (existing !== symPath) aliases[symPath] = existing;
      return existing;
    }
    if (claimed.size >= MAX_SYMBOLS) {
      truncated = true;
      return null;
    }
    claimed.set(resolved, symPath);
    queue.push({ sym: resolved, path: symPath, depth });
    return symPath;
  };

  for (const exp of checker.getExportsOfModule(moduleSymbol)) {
    const exportName = exp.getName();

    // A default-exported class is referenced by consumers under its declared
    // name (`new Stripe(...)`), never as "default". Claim the declared name
    // first so it becomes the canonical, human-recognisable path.
    if (exportName === 'default') {
      try {
        const n = resolveAlias(exp).getName();
        if (n && n !== 'default' && /^[A-Za-z_$][\w$]*$/.test(n)) {
          enqueue(exp, n, 0);
        }
      } catch {
        /* fall through to the plain export name */
      }
    }
    enqueue(exp, exportName, 0);
  }

  // Breadth-first: the shallowest path to a symbol is always claimed first, so
  // canonical paths are the short, recognisable ones.
  while (queue.length > 0) {
    const item = queue.shift();
    if (item === undefined) break;
    visit(item.sym, item.path, item.depth);
  }

  function visit(resolved: ts.Symbol, symPath: string, depth: number): void {
    const decl = resolved.valueDeclaration ?? resolved.declarations?.[0];
    if (!decl) return;

    let signature = '';
    let memberType: ts.Type | undefined;
    try {
      if (resolved.valueDeclaration) {
        const t = checker.getTypeOfSymbolAtLocation(resolved, resolved.valueDeclaration);
        signature = checker.typeToString(t, undefined, ts.TypeFormatFlags.NoTruncation);
        memberType = t;
      } else {
        const t = checker.getDeclaredTypeOfSymbol(resolved);
        signature = checker.typeToString(t, undefined, ts.TypeFormatFlags.NoTruncation);
        memberType = t;
      }
    } catch {
      signature = 'unresolved';
    }

    symbols[symPath] = {
      path: symPath,
      kind: kindOf(resolved.flags),
      signature: normaliseSignature(signature),
      deprecated: isDeprecated(resolved, checker),
      optional: Boolean(resolved.flags & ts.SymbolFlags.Optional),
    };

    if (depth >= MAX_DEPTH) return;
    // Record symbols re-exported from other packages as part of the surface, but
    // do not descend into them — their internals belong to that package, and
    // walking them is where the symbol budget goes to die.
    if (!declaredInPackage(resolved, pkgDirNormalised)) return;

    // Recurse into the *instance* shape for classes and interfaces. This is what
    // surfaces nested resource paths like `Stripe.charges.create`, which is where
    // real SDK breakage lives.
    const containerFlags = ts.SymbolFlags.Class | ts.SymbolFlags.Interface;
    let members: ts.Symbol[] = [];
    // The name consumers will see when the checker resolves a value of this
    // shape. Captured here, while we still know which type owns these members.
    let ownerTypeName: string | undefined;
    try {
      if (resolved.flags & containerFlags) {
        const declared = checker.getDeclaredTypeOfSymbol(resolved);
        members = checker.getPropertiesOfType(declared);
        ownerTypeName = declared.symbol?.getName() ?? resolved.getName();
      } else if (
        memberType &&
        resolved.flags &
          (ts.SymbolFlags.Property | ts.SymbolFlags.Variable | ts.SymbolFlags.BlockScopedVariable)
      ) {
        members = checker.getPropertiesOfType(memberType);
        ownerTypeName = memberType.symbol?.getName();
      } else if (resolved.flags & ts.SymbolFlags.Module) {
        members = checker.getExportsOfModule(resolved);
        ownerTypeName = resolved.getName();
      }
    } catch {
      members = [];
    }

    for (const m of members) {
      const name = m.getName();
      // Skip internals and anything not a plain identifier.
      if (name.startsWith('_') || name.startsWith('#')) continue;

      const canonical = enqueue(m, `${symPath}.${name}`, depth + 1);
      if (canonical === null) continue;

      // Point the type-member index at the path the symbol is actually recorded
      // under. These two must agree — a key here whose value is missing from
      // `symbols` silently loses a real API change.
      if (ownerTypeName && ownerTypeName !== '__type' && ownerTypeName !== '__object') {
        const key = `${ownerTypeName}.${name}`;
        if (!(key in byTypeMember)) byTypeMember[key] = canonical;
      }
    }
  }

  return {
    pkg,
    version,
    symbols,
    byTypeMember,
    aliases,
    entry,
    truncated,
    ...(truncated
      ? {
          note: `surface walk hit the ${MAX_SYMBOLS}-symbol limit; removal detection is suppressed for this package`,
        }
      : {}),
  };
}
