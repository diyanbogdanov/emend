/**
 * What a change would cost, before the change is made.
 *
 * Everything else in this codebase reasons about call sites of *someone else's*
 * API — the dependency broke, so where do we touch it. This is the mirror image:
 * the agent is about to reshape a symbol the repository owns, and nothing has
 * been telling it what else depends on that symbol. It finds out by the build
 * going red, and then retries with no more information than it had the first
 * time.
 *
 * **Multi-language by construction.** "Who references this symbol" has a real
 * answer in every language and a different implementation in each — TypeScript
 * has a type checker, Rust has one, Python has approximations. So the answer type
 * (`SymbolImpact`) is language-neutral and the finding of it sits behind
 * `ImpactAnalyzer`, the same seam `LintAdapter` uses for linters and OSV's
 * `ecosystem` uses for inventories. Adding a language here costs an analyzer, not a
 * rewrite of anything above it.
 *
 * **What a reference establishes.** For TypeScript, exactly what it says: the
 * checker resolved this identifier to that declaration, through whatever
 * aliases, re-exports and inheritance lie between. That is the same evidence
 * `tsc` itself would act on, so it is proof rather than a lead — the honest
 * caveat is only that it is proof *about the files in the program*, and a
 * program built from a directory scan (no tsconfig) may not be every file.
 * Dynamic access — `obj[name]()`, a string in a DI container — is invisible to
 * it, as it is to the compiler.
 */

import path from 'node:path';
import ts from 'typescript';
import { buildProgram } from './callsites.ts';

/** Where something that depends on a symbol lives. */
export interface ImpactSite {
  file: string;
  line: number;
  column: number;
  text: string;
}

/** One symbol, and what changing it would reach. */
export interface SymbolImpact {
  name: string;
  declaredIn: string;
  /** Uses outside the file that declares it. Its own file is the agent's to read. */
  external: ImpactSite[];
}

/**
 * One language's answer to "who references this".
 *
 * `handles` is the routing decision and belongs to the analyzer, so adding a
 * language never means editing a list somewhere else.
 */
export interface ImpactAnalyzer {
  id: string;
  handles(file: string): boolean;
  analyse(repoDir: string, files: string[]): Promise<SymbolImpact[]>;
}

const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

// ---------------------------------------------------------------------------
// TypeScript
// ---------------------------------------------------------------------------

/** Follow an import binding to the thing it was imported from. */
function resolveAlias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
  try {
    return checker.getAliasedSymbol(symbol);
  } catch {
    return symbol;
  }
}

/**
 * An import or export specifier names a symbol without depending on its shape.
 *
 * `import { formatPrice }` survives any change to what `formatPrice` does or
 * takes; only the call below it breaks. Counting the binding would report every
 * importing file twice and inflate the number the agent is being asked to weigh.
 */
function isBindingOnly(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    ts.isImportSpecifier(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent)
  );
}

/** The named things this file declares, by the symbol each one is. */
function declarationsIn(
  checker: ts.TypeChecker,
  source: ts.SourceFile,
): Map<ts.Symbol, { name: string; at: ts.Node }> {
  const found = new Map<ts.Symbol, { name: string; at: ts.Node }>();

  const record = (name: ts.Node | undefined): void => {
    if (!name || !ts.isIdentifier(name)) return;
    const symbol = checker.getSymbolAtLocation(name);
    if (symbol && !found.has(symbol)) found.set(symbol, { name: name.text, at: name });
  };

  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) record(decl.name);
      continue;
    }
    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      record(statement.name);
    }
    // A method's callers matter as much as a free function's, and reaching them
    // is one more level of the same walk.
    if (ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
      for (const member of statement.members) record(member.name);
    }
  }
  return found;
}

function relative(repoDir: string, file: string): string {
  return path.relative(repoDir, file).split(path.sep).join('/');
}

function analyseTypescript(repoDir: string, files: string[]): SymbolImpact[] {
  const warnings: string[] = [];
  // Building a program is fallible in ways a caller cannot anticipate — a
  // tsconfig with a circular `extends`, a path mapping onto a missing package.
  // The contract is "returns what it could establish", and an empty answer
  // already means "not measured" everywhere it is consumed, so a failure here
  // costs the prompt a section rather than costing the run.
  let program: ts.Program | null = null;
  try {
    program = buildProgram(repoDir, warnings);
  } catch {
    return [];
  }
  if (!program) return [];

  const checker = program.getTypeChecker();
  const wanted = new Set(files.map((f) => path.resolve(repoDir, f)));

  // What we are being asked about, and where each was declared.
  const targets = new Map<ts.Symbol, SymbolImpact>();
  const declaredAt = new Set<ts.Node>();

  for (const source of program.getSourceFiles()) {
    if (!wanted.has(path.resolve(source.fileName))) continue;
    for (const [symbol, decl] of declarationsIn(checker, source)) {
      declaredAt.add(decl.at);
      targets.set(symbol, {
        name: decl.name,
        declaredIn: relative(repoDir, source.fileName),
        external: [],
      });
    }
  }
  if (targets.size === 0) return [];

  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile) continue;
    const file = path.resolve(source.fileName);
    if (wanted.has(file)) continue; // its own file is the agent's to read
    if (!file.startsWith(path.resolve(repoDir))) continue;

    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && !declaredAt.has(node) && !isBindingOnly(node)) {
        const symbol = checker.getSymbolAtLocation(node);
        const impact = symbol ? targets.get(resolveAlias(checker, symbol)) : undefined;
        if (impact) {
          const at = source.getLineAndCharacterOfPosition(node.getStart(source));
          const file = relative(repoDir, source.fileName);
          // One line is one edit. `RANK[b.provenance] - RANK[a.provenance]` holds
          // two references and the agent fixes it once; listing it twice spends
          // two of five slots on a duplicate and overstates the reach.
          if (!impact.external.some((s) => s.file === file && s.line === at.line + 1)) {
            impact.external.push({
              file,
              line: at.line + 1,
              column: at.character + 1,
              text: (source.text.split('\n')[at.line] ?? '').trim().slice(0, 120),
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return [...targets.values()];
}

export function typescriptAnalyzer(): ImpactAnalyzer {
  return {
    id: 'typescript',
    handles: (file) => TS_EXTENSIONS.includes(path.extname(file)),
    analyse: async (repoDir, files) => analyseTypescript(repoDir, files),
  };
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const ANALYZERS: ImpactAnalyzer[] = [typescriptAnalyzer()];

/** The analyzer that can answer for this file, if one can. */
export function analyzerFor(file: string): ImpactAnalyzer | undefined {
  return ANALYZERS.find((a) => a.handles(file));
}

/**
 * What changing anything in these files would reach.
 *
 * Files no analyzer handles are silently absent rather than reported as having
 * no dependents — the difference between "nothing uses this" and "nobody looked"
 * is the one distinction this codebase never blurs.
 */
export async function analyseImpact(repoDir: string, files: string[]): Promise<SymbolImpact[]> {
  const byAnalyzer = new Map<ImpactAnalyzer, string[]>();
  for (const file of files) {
    const analyzer = analyzerFor(file);
    if (!analyzer) continue;
    byAnalyzer.set(analyzer, [...(byAnalyzer.get(analyzer) ?? []), file]);
  }

  const impacts: SymbolImpact[] = [];
  for (const [analyzer, owned] of byAnalyzer) {
    impacts.push(...(await analyzer.analyse(repoDir, owned)));
  }
  return impacts;
}

// ---------------------------------------------------------------------------
// What the agent is told
// ---------------------------------------------------------------------------

const MAX_SYMBOLS = 12;
const MAX_SITES = 5;

/**
 * The prompt's share of this.
 *
 * Symbols nothing else uses are omitted: they are the ones the agent may reshape
 * freely, and saying so for every private helper would bury the handful that
 * actually constrain it. Widest first, and the count is always the true count
 * even when the listing is cut short.
 */
export function renderImpact(impacts: SymbolImpact[]): string {
  const constrained = impacts
    .filter((i) => i.external.length > 0)
    .sort((a, b) => b.external.length - a.external.length)
    .slice(0, MAX_SYMBOLS);
  if (constrained.length === 0) return '';

  // The caveat travels with the data, not only in a numbered rule far above it.
  // What the checker resolves it resolves exactly; what it cannot see —
  // `obj[name]()`, a class named by a string in a container — it reports as
  // absent, and absent has to keep meaning "none found" rather than "none".
  const lines = [
    'Other code depends on these symbols. Changing their shape breaks it.',
    'Resolved with the type checker: exact for static uses, blind to reflection',
    'and dynamic property access. Absence below means none were found.',
    '',
  ];
  for (const impact of constrained) {
    const n = impact.external.length;
    lines.push(`- ${impact.name} (${impact.declaredIn}) — used in ${n} place${n === 1 ? '' : 's'}:`);
    for (const site of impact.external.slice(0, MAX_SITES)) {
      lines.push(`    ${site.file}:${site.line}  ${site.text}`);
    }
    if (n > MAX_SITES) lines.push(`    …and ${n - MAX_SITES} more`);
  }
  return lines.join('\n');
}
