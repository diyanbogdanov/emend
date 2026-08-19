/**
 * Locates where a repository actually uses symbols from tracked packages.
 *
 * Two resolution strategies run together, because neither is sufficient alone:
 *
 *  - import-based catches direct use of an imported binding (`z.string()`)
 *  - type-based catches use through arbitrarily-named values
 *    (`const c = new Stripe(k); c.charges.create()`), which import analysis
 *    cannot see because `c` is just a local variable
 */

import path from 'node:path';
import ts from 'typescript';
import type { ApiSurface, CallSite } from './types.ts';
import { findPythonCallSites } from './python/callsites.ts';

/**
 * Source files admitted to the TypeScript program.
 *
 * Bounded only so a runaway directory walk cannot exhaust memory. The largest
 * repository scanned so far (n8n) walks about 19,000 files, so this is far from
 * binding; a repository that trips it gets a warning saying results are partial.
 */
const MAX_FILES = 100_000;

export interface CallSiteIndex {
  /** package -> canonical symbol path -> sites */
  byPackage: Map<string, Map<string, CallSite[]>>;
  filesAnalyzed: number;
  warnings: string[];
}

interface Binding {
  pkg: string;
  /** Exported name, or '*' for a namespace import. */
  exportName: string;
}

/** `@scope/pkg/sub/path` -> `@scope/pkg`; `pkg/sub` -> `pkg`; relative -> null. */
export function packageOfSpecifier(spec: string): string | null {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) return null;
  const parts = spec.split('/');
  if (spec.startsWith('@')) {
    if (parts.length < 2) return null;
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0] ?? null;
}

/**
 * Walk up a property-access chain from an identifier, collecting segments.
 *
 * Stops at a call expression: in `z.string().min(5)`, `min` is a member of
 * whatever `z.string()` *returned*, not of `z.string`. Continuing through the
 * call would fabricate the path `z.string.min`, which does not exist.
 */
function accessSegments(node: ts.Node): string[] {
  const segments: string[] = [];
  let current: ts.Node = node;
  while (
    current.parent &&
    ts.isPropertyAccessExpression(current.parent) &&
    current.parent.expression === current
  ) {
    segments.push(current.parent.name.text);
    current = current.parent;
  }
  return segments;
}

export function buildProgram(
  repoDir: string,
  warnings: string[],
): ts.Program | null {
  const tsconfigPath = ts.findConfigFile(repoDir, ts.sys.fileExists, 'tsconfig.json');

  let fileNames: string[] = [];
  let options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowJs: true,
    skipLibCheck: true,
    skipDefaultLibCheck: true,
    strict: false,
    noEmit: true,
  };

  if (tsconfigPath && tsconfigPath.startsWith(path.resolve(repoDir))) {
    const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (read.error) {
      warnings.push(
        `tsconfig.json could not be parsed (${ts.flattenDiagnosticMessageText(read.error.messageText, ' ')}); falling back to a directory scan`,
      );
    } else {
      const parsed = ts.parseJsonConfigFileContent(
        read.config,
        ts.sys,
        path.dirname(tsconfigPath),
      );
      fileNames = parsed.fileNames;
      options = { ...parsed.options, noEmit: true, skipLibCheck: true };
    }
  }

  if (fileNames.length === 0) {
    const exts = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
    fileNames = walkDir(repoDir, exts);
  }

  fileNames = fileNames.filter(
    (f) => !f.includes(`${path.sep}node_modules${path.sep}`) && !f.endsWith('.d.ts'),
  );

  if (fileNames.length === 0) {
    warnings.push('no source files found to analyze');
    return null;
  }
  if (fileNames.length > MAX_FILES) {
    warnings.push(
      `repository has ${fileNames.length} source files; analyzing the first ${MAX_FILES}. Results are PARTIAL, not clean.`,
    );
    fileNames = fileNames.slice(0, MAX_FILES);
  }

  return ts.createProgram(fileNames, options);
}

export function walkDir(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'out']);
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let entries: string[];
    try {
      entries = ts.sys.readDirectory(current, undefined, undefined, undefined, 1);
    } catch {
      continue;
    }
    for (const e of entries) {
      const base = path.basename(e);
      if (skip.has(base)) continue;
      if (exts.some((x) => e.endsWith(x))) out.push(e);
    }
    // readDirectory with depth 1 returns files only; recurse into subdirectories.
    try {
      for (const sub of ts.sys.getDirectories(current)) {
        if (skip.has(sub)) continue;
        stack.push(path.join(current, sub));
      }
    } catch {
      /* unreadable directory — skip */
    }
  }
  return out;
}

/** Directory -> the package name declared there, or null. Paths repeat heavily. */
const packageNameCache = new Map<string, string | null>();

/**
 * Which package declares this file, by finding its nearest `package.json`.
 *
 * The obvious implementation — look for `/node_modules/` in the path and take
 * the next segment — is wrong whenever a package is reached through a symlink,
 * because TypeScript reports the resolved real path. That silently discarded
 * *every* type-based call site in two important cases: dependencies Emend stages
 * itself from its tarball cache, and any repository using pnpm, whose entire
 * `node_modules` is symlinks. Both looked like "this code doesn't use the API".
 *
 * Reading the manifest is authoritative regardless of how the file was reached.
 */
function owningPackage(declarationFile: string): string | null {
  let dir = path.dirname(path.resolve(declarationFile));
  // Deep enough for nested node_modules, bounded so a pathological path cannot
  // walk to the filesystem root one stat at a time.
  for (let depth = 0; depth < 16; depth++) {
    const cached = packageNameCache.get(dir);
    if (cached !== undefined) return cached;

    const manifest = path.join(dir, 'package.json');
    if (ts.sys.fileExists(manifest)) {
      let name: unknown;
      try {
        name = (JSON.parse(ts.sys.readFile(manifest) ?? '{}') as { name?: unknown }).name;
      } catch {
        name = undefined;
      }
      // Packages ship nameless `package.json` files inside subdirectories purely
      // to set `"type": "module"`. Those are not package boundaries; keep going.
      if (typeof name === 'string' && name.length > 0) {
        packageNameCache.set(dir, name);
        return name;
      }
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  packageNameCache.set(dir, null);
  return null;
}

export function findCallSites(
  repoDir: string,
  surfaces: Map<string, ApiSurface>,
  /** Only these canonical paths are interesting, per package. */
  wanted: Map<string, Set<string>>,
): CallSiteIndex {
  const warnings: string[] = [];
  const byPackage = new Map<string, Map<string, CallSite[]>>();
  for (const pkg of surfaces.keys()) byPackage.set(pkg, new Map());

  const program = buildProgram(repoDir, warnings);
  if (!program) return { byPackage, filesAnalyzed: 0, warnings };

  const checker = program.getTypeChecker();
  const repoAbs = path.resolve(repoDir);

  // Cheap pre-filter: only member names that could possibly matter. Without
  // this we would ask the type checker about every property access in the repo.
  const interestingMembers = new Set<string>();
  for (const [pkg, paths] of wanted) {
    const surface = surfaces.get(pkg);
    if (!surface) continue;
    for (const p of paths) {
      const last = p.split('.').at(-1);
      if (last) interestingMembers.add(last);
    }
    for (const key of Object.keys(surface.byTypeMember)) {
      const last = key.split('.').at(-1);
      if (last) interestingMembers.add(last);
    }
  }

  const seen = new Set<string>();
  let filesAnalyzed = 0;

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const abs = path.resolve(sf.fileName);
    if (!abs.startsWith(repoAbs)) continue;
    if (abs.includes(`${path.sep}node_modules${path.sep}`)) continue;
    filesAnalyzed++;

    const rel = path.relative(repoAbs, abs).split(path.sep).join('/');
    const lines = sf.getFullText().split('\n');
    const bindings = new Map<string, Binding>();

    const record = (pkg: string, canonical: string, node: ts.Node, via: 'import' | 'type') => {
      const wantedForPkg = wanted.get(pkg);
      if (!wantedForPkg || !wantedForPkg.has(canonical)) return;
      const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      const key = `${pkg}|${canonical}|${rel}|${line}|${character}`;
      if (seen.has(key)) return;
      seen.add(key);
      const bucket = byPackage.get(pkg);
      if (!bucket) return;
      const list = bucket.get(canonical) ?? [];
      list.push({
        file: rel,
        line: line + 1,
        column: character + 1,
        text: (lines[line] ?? '').trim().slice(0, 200),
        via,
      });
      bucket.set(canonical, list);
    };

    // Pass 1 — collect import bindings for tracked packages.
    const collectImports = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const pkg = packageOfSpecifier(node.moduleSpecifier.text);
        if (pkg && surfaces.has(pkg)) {
          const clause = node.importClause;
          if (clause?.name) {
            bindings.set(clause.name.text, { pkg, exportName: 'default' });
          }
          const nb = clause?.namedBindings;
          if (nb && ts.isNamespaceImport(nb)) {
            bindings.set(nb.name.text, { pkg, exportName: '*' });
          } else if (nb && ts.isNamedImports(nb)) {
            for (const el of nb.elements) {
              bindings.set(el.name.text, {
                pkg,
                exportName: el.propertyName?.text ?? el.name.text,
              });
            }
          }
        }
      }
      // `const x = require('pkg')` — still common in JS repos.
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        node.initializer.expression.text === 'require' &&
        node.initializer.arguments.length === 1
      ) {
        const arg = node.initializer.arguments[0];
        if (arg && ts.isStringLiteral(arg) && ts.isIdentifier(node.name)) {
          const pkg = packageOfSpecifier(arg.text);
          if (pkg && surfaces.has(pkg)) {
            bindings.set(node.name.text, { pkg, exportName: '*' });
          }
        }
      }
      ts.forEachChild(node, collectImports);
    };
    collectImports(sf);

    // Pass 2 — resolve usages.
    const visit = (node: ts.Node): void => {
      // Import-based: an identifier bound to a tracked package export.
      if (ts.isIdentifier(node) && bindings.has(node.text)) {
        const isDeclarationName =
          (ts.isImportSpecifier(node.parent) ||
            ts.isImportClause(node.parent) ||
            ts.isNamespaceImport(node.parent)) &&
          (node.parent as { name?: ts.Node }).name === node;
        const isPropertyName =
          ts.isPropertyAccessExpression(node.parent) && node.parent.name === node;

        if (!isDeclarationName && !isPropertyName) {
          const binding = bindings.get(node.text);
          if (binding) {
            const segs = accessSegments(node);
            const base = binding.exportName === '*' ? [] : [binding.exportName];
            const full = [...base, ...segs];
            const surface = surfaces.get(binding.pkg);
            // Check every prefix: `z.string` matters even when the source reads
            // `z.string().min()`, and the bare binding matters when the whole
            // export was removed. Resolve through aliases, because the path the
            // source writes (`z.record`) may not be the canonical one (`record`).
            for (let i = full.length; i >= 1; i--) {
              const written = full.slice(0, i).join('.');
              const candidate = surface?.aliases[written] ?? written;
              if (surface?.symbols[candidate] || wanted.get(binding.pkg)?.has(candidate)) {
                record(binding.pkg, candidate, node, 'import');
              }
            }
          }
        }
      }

      // Type-based: property access on a value whose type comes from a tracked
      // package. This is what catches `client.charges.create(...)`.
      if (
        ts.isPropertyAccessExpression(node) &&
        interestingMembers.has(node.name.text)
      ) {
        try {
          const objType = checker.getTypeAtLocation(node.expression);
          const sym = objType.aliasSymbol ?? objType.getSymbol();
          const decls = sym?.declarations;
          if (sym && decls && decls.length > 0) {
            for (const d of decls) {
              const owningPkg = owningPackage(d.getSourceFile().fileName);
              if (!owningPkg || !surfaces.has(owningPkg)) continue;
              const surface = surfaces.get(owningPkg);
              if (!surface) continue;
              const canonical =
                surface.byTypeMember[`${sym.getName()}.${node.name.text}`];
              if (canonical) record(owningPkg, canonical, node.name, 'type');
              break;
            }
          }
        } catch {
          /* checker could not resolve this node — nothing to record for it */
        }
      }

      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  return { byPackage, filesAnalyzed, warnings };
}

/**
 * One language's answer to "where does this repository use these symbols".
 *
 * The negative is the load-bearing half: "not imported from this repository's
 * source" is a claim about files that were actually parsed. A language with no
 * resolver is absent here, so that claim is never made on its behalf.
 */
export interface CallSiteResolver {
  id: string;
  /**
   * OSV ecosystems this resolver finds call sites for — `['npm']` for the
   * TypeScript resolver. `resolverForEcosystem` reads this directly, so it
   * must name every ecosystem the resolver actually serves, not just the file
   * extensions `handles` happens to accept.
   */
  ecosystems: string[];
  /** Whether this resolver can parse `file` well enough to search it. */
  handles(file: string): boolean;
  /**
   * Where `repoDir` calls the tracked symbols of `surfaces`, narrowed to
   * `wanted`.
   *
   * Returns a bare `CallSiteIndex` or a `Promise` of one: the TypeScript
   * resolver builds its whole program synchronously and returns directly;
   * the Python resolver (`python/callsites.ts`) cannot — its parser loads a
   * WASM grammar, and `web-tree-sitter` only offers an async API for that —
   * so forcing one shape onto the other would mean either wrapping every
   * synchronous call in a needless `Promise.resolve`, or blocking Python's
   * parser on a synchronous load it cannot do. `locateCallSites` (below) is
   * the caller: it dispatches per ecosystem through `resolverForEcosystem`
   * and `await`s every resolver's `find` uniformly, which resolves either
   * kind alike.
   */
  find(
    repoDir: string,
    surfaces: Map<string, ApiSurface>,
    wanted: Map<string, Set<string>>,
  ): CallSiteIndex | Promise<CallSiteIndex>;
}

const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const PY_EXTENSIONS = ['.py', '.pyi'];

// Every language a repository's call sites can be searched in. Registering one
// here is what makes a language searchable at all — leaving one out is not a
// crash, it is `resolverFor` returning `undefined`, which keeps "not imported
// from this repository's source" from being said about a file nothing read.
// `ecosystems` must list every ecosystem this resolver actually serves:
// `resolverForEcosystem` (below) and `capabilitiesFor` (languages.ts) trust it
// directly, with no file or repository in hand to check it against.
const RESOLVERS: CallSiteResolver[] = [
  {
    id: 'typescript',
    ecosystems: ['npm'],
    handles: (file) => TS_EXTENSIONS.some((ext) => file.endsWith(ext)),
    find: findCallSites,
  },
  {
    id: 'python',
    ecosystems: ['PyPI'],
    handles: (file) => PY_EXTENSIONS.some((ext) => file.endsWith(ext)),
    find: findPythonCallSites,
  },
];

/**
 * The resolver that can search this file, if one is registered for it.
 *
 * Not yet called from the scan pipeline: `findCallSites` discovers its own
 * files from `repoDir` rather than accepting a list, so there is nothing here
 * to route per-file today.
 */
export function resolverFor(file: string): CallSiteResolver | undefined {
  return RESOLVERS.find((r) => r.handles(file));
}

/**
 * The resolver that finds call sites for this OSV ecosystem, if one is
 * registered.
 *
 * A different question from `resolverFor`: that one asks "can you parse this
 * file", routed by extension, for a file that is actually on disk. This one
 * asks "do you serve this ecosystem at all", with neither a file nor a
 * repository in hand — which is what `capabilitiesFor` (languages.ts) needs
 * answered to report coverage before, or instead of, running a scan, and what
 * `locateCallSites` (below) needs to route each tracked package to the
 * resolver that can actually read its files.
 */
export function resolverForEcosystem(ecosystem: string): CallSiteResolver | undefined {
  return RESOLVERS.find((r) => r.ecosystems.includes(ecosystem));
}

/**
 * Locates call sites for every tracked package, dispatched through each
 * package's own ecosystem resolver (`resolverForEcosystem`) and merged into
 * one index. This is the scan pipeline's actual entry point into the
 * `CallSiteResolver` seam above — `analyze.ts` calls this, never a single
 * resolver directly, which is what makes registering a resolver in
 * `RESOLVERS` load-bearing rather than decorative.
 *
 * A single resolver cannot serve two languages: the TypeScript resolver
 * builds a `ts.Program` and can never see a `.py` file; the Python resolver
 * walks `.py`/`.pyi` files and can never see a `.ts` one. Calling one
 * resolver on every tracked package regardless of ecosystem is not a partial
 * answer, it is a wrong one — every package outside that resolver's own
 * ecosystem silently gets zero call sites, which reads as "not called from
 * this repository" when the truth is "never searched at all".
 *
 * `ecosystemOf` supplies the fact `surfaces`/`wanted` do not carry
 * themselves — both are keyed by package name alone, the shape every
 * `CallSiteResolver.find` accepts, so the ecosystem has to travel beside
 * them rather than inside them.
 *
 * The merge stays honest in both directions a careless one could hide:
 * `filesAnalyzed` is the sum across every resolver that ran — a `.ts` file
 * and a `.py` file are disjoint sets, so summing double-counts nothing —
 * and `warnings` is the concatenation of every resolver's own warnings,
 * because dropping one resolver's warnings here would hide exactly the
 * coverage gaps this codebase exists to report. A package whose ecosystem no
 * resolver claims is not silently dropped either: it is named in its own
 * warning and still gets an (empty) bucket, so its impacting changes count
 * as unlocated rather than vanishing into a false "clean".
 */
export async function locateCallSites(
  repoDir: string,
  surfaces: Map<string, ApiSurface>,
  wanted: Map<string, Set<string>>,
  ecosystemOf: Map<string, string>,
): Promise<CallSiteIndex> {
  const byPackage = new Map<string, Map<string, CallSite[]>>();
  const warnings: string[] = [];
  let filesAnalyzed = 0;

  const groups = new Map<string, { surfaces: Map<string, ApiSurface>; wanted: Map<string, Set<string>> }>();
  for (const [pkg, surface] of surfaces) {
    const ecosystem = ecosystemOf.get(pkg) ?? '';
    let group = groups.get(ecosystem);
    if (!group) {
      group = { surfaces: new Map(), wanted: new Map() };
      groups.set(ecosystem, group);
    }
    group.surfaces.set(pkg, surface);
    const w = wanted.get(pkg);
    if (w) group.wanted.set(pkg, w);
  }

  for (const [ecosystem, group] of groups) {
    const resolver = resolverForEcosystem(ecosystem);
    if (!resolver) {
      const pkgs = [...group.surfaces.keys()];
      warnings.push(
        `no call-site resolver claims ecosystem '${ecosystem || '(unknown)'}'; ` +
          `${pkgs.length} package(s) (${pkgs.join(', ')}) were not searched for call sites`,
      );
      for (const pkg of pkgs) byPackage.set(pkg, new Map());
      continue;
    }
    const index = await resolver.find(repoDir, group.surfaces, group.wanted);
    filesAnalyzed += index.filesAnalyzed;
    warnings.push(...index.warnings);
    for (const [pkg, bucket] of index.byPackage) byPackage.set(pkg, bucket);
  }

  return { byPackage, filesAnalyzed, warnings };
}
