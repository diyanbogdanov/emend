/**
 * Cross-examine every reported removal against the new version's declarations.
 *
 * The point is independence. Asking the surface walk whether a symbol is missing
 * is asking the accused to testify: the aliased-re-export bug survived precisely
 * because `symbols` and the diff agreed with each other. So this resolves each
 * reported path the way a *consumer* would — module exports, then property
 * lookups on the resolved type — using the checker directly and none of Emend's
 * indexing.
 *
 * Any path Emend called removed that still resolves this way is a suspected
 * false positive — suspected, not proven, because this checker is deliberately
 * cruder than the real one and has its own blind spot: it cannot distinguish a
 * namespace *type* from a class *property* of the same name. `stripe` exports
 * both a `Stripe.StripeResource` type and, in v21 only, a property by that
 * name; the property really was removed in v22 and this script reports it as
 * surviving. Verify anything it flags against the raw declarations before
 * treating it as a bug.
 *
 * Run with: npm run audit:removals
 */
import ts from 'typescript';
import path from 'node:path';
import { fetchPackageDir, resolveTargetVersion, clientFor } from '../src/registry.ts';
import { compareVersions } from '../src/versions.ts';
import { extractSurface, resolveTypesEntry } from '../src/surface.ts';
import { diffSurfaces } from '../src/diff.ts';

const PACKAGES = [
  '@radix-ui/react-avatar', '@radix-ui/react-dialog', '@radix-ui/react-select',
  'stripe', 'mongodb', '@supabase/supabase-js', 'firebase-admin',
  '@slack/web-api', '@octokit/rest', 'resend', 'axios', 'zod', 'ioredis',
  '@sentry/node', 'twilio', 'drizzle-orm', 'openai', '@anthropic-ai/sdk',
];

const MAX_CHECKED_PER_PKG = 40;

/** Resolve a dotted path against a module the way a consumer would. */
function resolvesInModule(
  entry: string,
  program: ts.Program,
  checker: ts.TypeChecker,
  dotted: string,
): boolean {
  const source = program.getSourceFile(entry);
  if (!source) return false;

  const fileSymbol = checker.getSymbolAtLocation(source);
  let exports: ts.Symbol[] = [];
  try {
    exports = fileSymbol ? checker.getExportsOfModule(fileSymbol) : [];
  } catch {
    exports = [];
  }
  if (exports.length === 0) {
    // `declare module 'x'` / `export =` shapes.
    for (const st of source.statements) {
      if (ts.isModuleDeclaration(st) && ts.isStringLiteral(st.name)) {
        const s = checker.getSymbolAtLocation(st.name);
        if (s) {
          try { exports = exports.concat(checker.getExportsOfModule(s)); } catch { /* skip */ }
        }
      }
    }
  }

  const segments = dotted.split('.');
  const head = segments[0] ?? '';
  let current = exports.find((e) => e.getName() === head);
  // `export =` assigns the surface to one symbol; consumers still spell members
  // off it, so treat its members as top-level too.
  if (!current) {
    const eq = fileSymbol?.exports?.get('export=' as ts.__String);
    if (eq) {
      const target = eq.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(eq) : eq;
      try {
        current = checker.getExportsOfModule(target).find((e) => e.getName() === head)
          ?? checker.getPropertiesOfType(checker.getTypeOfSymbolAtLocation(target, source))
               .find((e) => e.getName() === head);
      } catch { /* unresolved */ }
    }
  }
  if (!current) return false;

  for (const segment of segments.slice(1)) {
    let members: ts.Symbol[] = [];
    try {
      const declared =
        current.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface)
          ? checker.getDeclaredTypeOfSymbol(current)
          : checker.getTypeOfSymbolAtLocation(current, source);
      members = checker.getPropertiesOfType(declared);
      for (const sig of declared.getConstructSignatures()) {
        members = members.concat(checker.getPropertiesOfType(sig.getReturnType()));
      }
      if (current.flags & ts.SymbolFlags.Module) {
        members = members.concat(checker.getExportsOfModule(current));
      }
    } catch {
      return false;
    }
    const next = members.find((m) => m.getName() === segment);
    if (!next) return false;
    current = next;
  }
  return true;
}

function programFor(entry: string): { program: ts.Program; checker: ts.TypeChecker } {
  const program = ts.createProgram([entry], {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    skipDefaultLibCheck: true,
    strict: false,
  });
  return { program, checker: program.getTypeChecker() };
}

function pickFrom(versions: string[], to: string): string | null {
  const toMajor = Number.parseInt(to.split('.')[0] ?? '0', 10);
  const stable = versions.filter((v) => !v.includes('-')).sort(compareVersions);
  const prev = stable.filter((v) => Number.parseInt(v.split('.')[0] ?? '0', 10) === toMajor - 1);
  if (prev.length > 0) return prev.at(-1) ?? null;
  const older = stable.filter((v) => compareVersions(v, to) < 0);
  return older.length ? (older[Math.max(0, older.length - 20)] ?? null) : null;
}

let totalRemovals = 0;
let totalFalse = 0;
const offenders: string[] = [];

for (const pkg of PACKAGES) {
  try {
    // `PACKAGES` is npm-only, but the lookup still returns `undefined` for an
    // ecosystem nothing claims rather than asserting one exists.
    const client = clientFor('npm');
    if (!client) throw new Error(`no registry client claims ecosystem 'npm'`);
    const pack = await client.versions(pkg);
    const to = resolveTargetVersion(pack);
    if (!to) continue;
    const from = pickFrom(pack.versions, to);
    if (!from) continue;

    const [fd, td] = await Promise.all([fetchPackageDir(pkg, from), fetchPackageDir(pkg, to)]);
    const [fs, tsur] = await Promise.all([
      extractSurface(fd, pkg, from),
      extractSurface(td, pkg, to),
    ]);
    const removals = diffSurfaces(fs, tsur).changes.filter((c) => c.kind === 'removed');
    if (removals.length === 0) {
      console.log(`  ${pkg.padEnd(26)} ${from} -> ${to}   no removals`);
      continue;
    }

    const entry = await resolveTypesEntry(td);
    if (!entry) continue;
    const { program, checker } = programFor(entry);

    const checked = removals.slice(0, MAX_CHECKED_PER_PKG);
    const stillThere = checked.filter((c) => resolvesInModule(entry, program, checker, c.path));

    totalRemovals += checked.length;
    totalFalse += stillThere.length;
    const flag = stillThere.length > 0 ? '  <-- FALSE POSITIVES' : '';
    console.log(
      `  ${pkg.padEnd(26)} ${String(from).padEnd(9)} -> ${String(to).padEnd(9)} ` +
        `removals=${String(removals.length).padStart(4)} checked=${String(checked.length).padStart(3)} ` +
        `still-resolvable=${String(stillThere.length).padStart(3)}${flag}`,
    );
    if (stillThere.length > 0) {
      offenders.push(pkg);
      for (const c of stillThere.slice(0, 4)) console.log(`      ${c.path}`);
    }
  } catch (err) {
    console.log(`  ${pkg.padEnd(26)} ERROR ${(err as Error).message.slice(0, 70)}`);
  }
}

console.log('');
console.log(`  checked ${totalRemovals} reported removals across ${PACKAGES.length} packages`);
console.log(`  still resolvable in the new version: ${totalFalse}` +
  (totalFalse === 0 ? '  (no false positives found)' : `  in: ${[...new Set(offenders)].join(', ')}`));
