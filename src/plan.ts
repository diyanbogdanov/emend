/**
 * Turns findings into concrete, deterministic edits.
 *
 * Scope is deliberately narrow: the *rename* class, which is the most common
 * real breaking change (`error.errors` -> `error.issues`, `client.foo.create` ->
 * `client.resources.create`). Anything the planner cannot express as an exact
 * rename produces no plan at all.
 *
 * Refusing to guess is the point. A wrong automated edit costs far more trust
 * than an honest "found it, cannot fix it automatically" — and the research on
 * agent-generated migrations (BigBag, arXiv 2606.24446) supports generating one
 * reusable, checkable transformation over improvising per repository.
 */

import type {
  ApiSymbol,
  Finding,
  MigrationPlan,
  PlannedEdit,
  SurfaceChange,
} from './types.ts';

/**
 * Loose signature comparison for rename matching.
 *
 * Renames frequently ship alongside a type rename in the same release — zod 4
 * renamed `ZodError.errors` to `.issues` *and* `ZodIssue` to `$ZodIssue`, so the
 * signatures are `ZodIssue[]` and `$ZodIssue[]`. Those describe the same thing.
 */
function looseSignature(sig: string): string {
  return sig.replace(/[$_]/g, '').replace(/\s+/g, '').toLowerCase();
}

function parentPath(p: string): string {
  const i = p.lastIndexOf('.');
  return i === -1 ? '' : p.slice(0, i);
}

function lastSegment(p: string): string {
  const i = p.lastIndexOf('.');
  return i === -1 ? p : p.slice(i + 1);
}

export interface RenameCandidate {
  from: string;
  to: string;
  score: number;
}

/**
 * Find a unique rename target for a removed symbol.
 *
 * Candidates are drawn from *every* symbol present in the target version, not
 * only newly-added ones. Careful API deprecation adds the new name first,
 * deprecates the old one, and removes it a release later — by which point the
 * replacement is not "new" at all. zod's `ZodError.errors` -> `.issues` is
 * exactly this shape, and an added-only search finds nothing.
 */
export function findRename(
  removed: SurfaceChange,
  toSymbols: Record<string, ApiSymbol>,
): RenameCandidate | null {
  if (removed.kind !== 'removed' || removed.before === null) return null;

  const parent = parentPath(removed.path);
  const scored: RenameCandidate[] = [];

  for (const cand of Object.values(toSymbols)) {
    // A rename keeps the member in the same container. Cross-container moves are
    // a different, much riskier transformation and are out of scope.
    if (parentPath(cand.path) !== parent) continue;
    if (lastSegment(cand.path) === lastSegment(removed.path)) continue;
    // A replacement that is itself deprecated is a dead end, not a migration.
    if (cand.deprecated) continue;

    let score = 0;
    if (cand.signature === removed.before) score = 100;
    else if (looseSignature(cand.signature) === looseSignature(removed.before)) score = 80;
    else continue;

    scored.push({ from: removed.path, to: cand.path, score });
  }

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best) return null;
  // Ambiguity is a refusal, not a coin flip.
  const tied = scored.filter((s) => s.score === best.score);
  if (tied.length > 1) return null;
  return best;
}

/**
 * Build a plan for a finding, or null when no safe deterministic edit exists.
 *
 * `toSymbols` is the full symbol table of the target version — the planner needs
 * it to find replacement candidates, which are not necessarily new symbols.
 */
export function planFinding(
  finding: Finding,
  toSymbols: Record<string, ApiSymbol>,
): MigrationPlan | null {
  const rename = findRename(finding.change, toSymbols);
  if (!rename) return null;

  const oldName = lastSegment(rename.from);
  const newName = lastSegment(rename.to);

  const edits: PlannedEdit[] = [];
  for (const site of finding.sites) {
    // Only `type`-resolved sites point at the member identifier itself, which is
    // exactly the token a rename must replace. An `import`-resolved site points at
    // the head of the access chain (`z` in `z.string().min()`), so rewriting at
    // that column would corrupt the source.
    if (site.via !== 'type') continue;
    edits.push({
      file: site.file,
      line: site.line,
      column: site.column,
      find: oldName,
      replace: newName,
      reason: `${rename.from} was removed in ${finding.toVersion}; ${rename.to} has the equivalent signature`,
    });
  }

  if (edits.length === 0) return null;

  return {
    findingId: finding.id,
    pkg: finding.pkg,
    fromVersion: finding.fromVersion,
    toVersion: finding.toVersion,
    kind: 'rename',
    edits,
    rationale:
      `Rename \`${oldName}\` to \`${newName}\` at ${edits.length} call site(s). ` +
      `\`${rename.from}\` no longer exists in ${finding.pkg}@${finding.toVersion}; ` +
      `\`${rename.to}\` is the only symbol in the same container with a matching signature ` +
      `(match confidence ${rename.score}/100).`,
  };
}

/** Plan every finding that can be planned; unplannable findings are simply absent. */
export function planAll(
  findings: Finding[],
  symbolsByPackage: Map<string, Record<string, ApiSymbol>>,
): MigrationPlan[] {
  const plans: MigrationPlan[] = [];
  for (const f of findings) {
    const toSymbols = symbolsByPackage.get(f.pkg);
    if (!toSymbols) continue;
    const plan = planFinding(f, toSymbols);
    if (plan) plans.push(plan);
  }
  return plans;
}
