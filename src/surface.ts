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
import type { ApiSurface, ApiSymbol, SymbolKind, TypeParam } from './types.ts';
import { materializeTypeDeps } from './registry.ts';

/**
 * Bounds on the walk.
 *
 * These are memory ceilings, not taste. The walk terminates on its own — every
 * symbol is claimed once — so the limits exist because a surface is held
 * entirely in memory and the signature strings dominate it. googleapis is the
 * measured worst case at 400,630 symbols, 52s and about 3 GB of heap; the same
 * package under the old 25,000 ceiling took 4.4s and 1.9 GB while reporting
 * itself truncated. Every other package tried is at least two orders of
 * magnitude smaller (zod: 2,342 symbols, 0.4s, 189 MB).
 *
 * Set high enough that no real package truncates, and honest when one does:
 * `truncated` suppresses removal reporting, so a cut-short walk understates
 * findings rather than inventing them.
 */
const MAX_DEPTH = 12;
const MAX_SYMBOLS = 600_000;
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
/**
 * A declaration's type parameters, with whether each carries a default.
 *
 * Taken from the declaration rather than the type string because the type
 * string does not carry it — see `TypeParam`. Absent on the great majority of
 * symbols, which is why the field is optional rather than an empty array.
 */
function readTypeParams(decl: ts.Declaration): TypeParam[] {
  const params = (decl as { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> })
    .typeParameters;
  if (!params) return [];
  return params.map((p) => ({ name: p.name.text, defaulted: p.default !== undefined }));
}

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
  // A cached module path names a place on this disk, and that place carries the
  // version: `…/cache/@radix-ui+react-accordion/1.2.12/package/dist/index`. Left
  // alone it changes on every upgrade whether or not the API did, so every
  // namespace re-export reported as breaking every time. Measured on
  // activepieces, that was 26 of 81 breaking findings — radix-ui alone 21.
  //
  // Reduced to the module rather than removed: the package and the subpath are
  // what say *which* module this is, and dropping them would make every
  // re-export in a package compare equal to every other. It also keeps somebody's
  // home directory out of stored findings and pull request bodies.
  let s = raw.replace(
    /(["'])[^"']*?\/cache\/([^/"']+)\/[^/"']+\/package\/([^"']*)\1/g,
    '$1$2/$3$1',
  );
  s = s.replace(/import\((?:"[^"]*"|'[^']*')\)\./g, '');
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

const partsToText = (parts?: ts.SymbolDisplayPart[]): string =>
  (parts ?? []).map((p) => p.text).join('').trim();

/**
 * What a deprecated declaration says to do instead.
 *
 * Three sources, because library authors use all three. recharts puts the
 * instruction in the description and the migration guide in `@see`, leaving
 * `@deprecated` itself bare; other packages put it inline after `@deprecated`.
 * Taking only one of them misses most of them.
 *
 * Called only for symbols already known to be deprecated. Every symbol has
 * documentation, the surface holds thousands of them, and none of the rest is a
 * migration instruction.
 */
function deprecationGuidance(sym: ts.Symbol, checker: ts.TypeChecker): string | undefined {
  try {
    const description = partsToText(sym.getDocumentationComment(checker));
    const tags = sym.getJsDocTags(checker);
    const inline = tags
      .filter((t) => t.name === 'deprecated' || t.name === 'see')
      .map((t) => partsToText(t.text))
      .filter(Boolean);
    const text = [description, ...inline].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    // Bounded: this rides in the prompt beside the signature, and a long
    // description would crowd out the compiler output that outranks it.
    return text ? text.slice(0, 600) : undefined;
  } catch {
    return undefined;
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

/**
 * True when a symbol is declared inside the package or its materialised type
 * closure.
 *
 * The closure has to count. A facade package like `playwright` declares almost
 * nothing itself — its types live in `playwright-core`, which Emend places in a
 * sibling `node_modules`. Restricting the walk to the package directory alone
 * stops it at the front door and yields a surface with no members in it, which
 * is what "playwright: 74 symbols, 0 nested" meant.
 *
 * The roots are explicit rather than "some parent directory" so that widening
 * the boundary cannot accidentally admit unrelated packages that happen to sit
 * nearby on disk.
 */
function declaredInScope(sym: ts.Symbol, roots: readonly string[]): boolean {
  const decls = sym.declarations;
  if (!decls || decls.length === 0) return false;
  return decls.some((d) => {
    const f = d.getSourceFile().fileName.replace(/\\/g, '/');
    return roots.some((r) => f.startsWith(r));
  });
}

/**
 * Find the symbol whose exports represent the package's public API.
 *
 * Three shapes exist in the wild and all must work:
 *
 *  1. ES module — the source file is itself the module (modern SDKs).
 *  2. Ambient module — the file contains `declare module 'stripe' { ... }` and
 *     is not a module itself, so asking the checker about the *file* yields
 *     nothing. Older CJS-first SDKs use this; `stripe@21` is exactly this case
 *     and silently produced a zero-symbol surface.
 *  3. `export =` — a CommonJS export assignment, where the real surface hangs
 *     off the assigned symbol rather than off the file's exports.
 */
function resolveModuleSymbol(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  const fileSymbol = checker.getSymbolAtLocation(source);
  if (fileSymbol && checker.getExportsOfModule(fileSymbol).length > 0) return fileSymbol;

  // `export = X`
  const exportEquals = fileSymbol?.exports?.get('export=' as ts.__String);
  if (exportEquals) {
    try {
      const target =
        exportEquals.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(exportEquals)
          : exportEquals;
      if (checker.getExportsOfModule(target).length > 0) return target;
      // An `export =` of a class/namespace exposes its members, not module exports.
      if (target.exports && target.exports.size > 0) return target;
    } catch {
      /* fall through to ambient module search */
    }
  }

  // `declare module 'name' { ... }` — pick the declaration with the most exports.
  let best: ts.Symbol | undefined;
  let bestCount = 0;
  for (const statement of source.statements) {
    if (!ts.isModuleDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.name)) continue;
    const sym = checker.getSymbolAtLocation(statement.name);
    if (!sym) continue;
    try {
      const count = checker.getExportsOfModule(sym).length;
      if (count > bestCount) {
        best = sym;
        bestCount = count;
      }
    } catch {
      /* skip unusable declaration */
    }
  }
  if (best) return best;

  return fileSymbol;
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

  // Declarations routinely re-export from a sibling package (`playwright` from
  // `playwright-core`). Without those on disk the imported types resolve to
  // errors and the surface comes back hollow — indistinguishable from a package
  // that ships no types at all. Placing them where TypeScript's own resolver
  // looks is what makes such packages analysable.
  const typeDepRoots = await materializeTypeDeps(pkgDir);

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

  const moduleSymbol = resolveModuleSymbol(source, checker);
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
  const walkRoots = [pkgDir, ...typeDepRoots].map((d) =>
    path.resolve(d).replace(/\\/g, '/'),
  );
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

    const typeParams = readTypeParams(decl);
    const deprecated = isDeprecated(resolved, checker);
    // Only for deprecations. Every symbol has documentation, a surface holds
    // thousands of them, and none of the rest is a migration instruction.
    const guidance = deprecated ? deprecationGuidance(resolved, checker) : undefined;
    symbols[symPath] = {
      path: symPath,
      kind: kindOf(resolved.flags),
      signature: normaliseSignature(signature),
      deprecated,
      ...(guidance ? { doc: guidance } : {}),
      optional: Boolean(resolved.flags & ts.SymbolFlags.Optional),
      ...(typeParams.length > 0 ? { typeParams } : {}),
    };

    if (depth >= MAX_DEPTH) return;
    // Record symbols re-exported from other packages as part of the surface, but
    // do not descend into them — their internals belong to that package, and
    // walking them is where the symbol budget goes to die.
    if (!declaredInScope(resolved, walkRoots)) return;

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

    // `export declare const X: typeof Core & Constructor<...>` — a value whose
    // real surface is reachable only through `new X()`. Its *properties* are the
    // static side; everything consumers call lives on the constructed instance.
    //
    // @octokit/rest is built exactly this way, which is why it produced a
    // six-symbol surface: `octokit.rest.repos.get` and every other endpoint hang
    // off the instance type and none of them are visible statically.
    try {
      if (memberType) {
        for (const sig of memberType.getConstructSignatures()) {
          const instance = sig.getReturnType();
          members = members.concat(checker.getPropertiesOfType(instance));
          // An intersection like `Core & Constructor<...>` is anonymous, so the
          // instance type has no name to index members under. Consumers still
          // spell the type by the exported binding (`const o: Octokit`), which
          // is what the checker reports at a call site — so use that name.
          ownerTypeName ??= instance.symbol?.getName() ?? resolved.getName();
        }
      }
    } catch {
      /* keep whatever the static walk found */
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

  // A resolved entry that yields nothing is NOT an empty API — it means the walk
  // failed. Real causes seen in the wild: types generated at install time
  // (`@prisma/client` is `export * from '.prisma/client/default'`, which does not
  // exist until `prisma generate` runs), or an entry whose surface is re-exported
  // from a dependency that is not present in the extracted tarball.
  //
  // Reporting this as `analyzed` with zero findings would read as "clean", which
  // is the single most dangerous thing this tool could say.
  if (Object.keys(symbols).length === 0) {
    return {
      pkg,
      version,
      symbols,
      byTypeMember,
      aliases,
      entry: null,
      truncated,
      note: `declaration entry ${path.basename(entry)} resolved but produced no symbols — types are likely generated at install time or re-exported from a package not present in the published tarball`,
    };
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
