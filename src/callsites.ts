/**
 * Locates where a repository actually uses symbols from tracked packages.
 *
 * This is the half that turns a diff into a work order. "zod 3->4 removed 40
 * symbols" is noise; "zod 3->4 removed `.strict()`, which you call at
 * src/schema.ts:14" is actionable. Everything downstream keys off these sites.
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

const MAX_FILES = 3000;

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

function buildProgram(
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

function walkDir(dir: string, exts: string[]): string[] {
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
              const file = d.getSourceFile().fileName.replace(/\\/g, '/');
              const marker = '/node_modules/';
              const idx = file.lastIndexOf(marker);
              if (idx === -1) continue;
              const after = file.slice(idx + marker.length);
              const segs = after.split('/');
              const owningPkg = after.startsWith('@')
                ? `${segs[0]}/${segs[1]}`
                : segs[0];
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
          /* checker could not resolve — nothing to record, and we say so via warnings only if global */
        }
      }

      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  return { byPackage, filesAnalyzed, warnings };
}
