/**
 * Diffs two API surfaces into a set of classified changes.
 *
 * Every classification here is deterministic — no model is consulted. That is a
 * deliberate constraint: the research on LLM-driven dependency migration
 * (Byam, arXiv 2505.07522) found that model-generated end-to-end fixes fully
 * repaired only 27% of builds. Detection must be something we can be certain
 * about, so that anything generative downstream is checked against ground truth
 * rather than trusted.
 */

import type { ApiSurface, SurfaceChange, SurfaceDiff } from './types.ts';

/**
 * Split the first parameter list of a signature into top-level parameters.
 *
 * Every step here has to be nesting-aware. Type text is full of nested
 * parentheses, generics, object literals and tuples, so scanning for the first
 * `)` or splitting on every `,` produces nonsense on any realistic SDK
 * signature.
 */
export function parameterList(signature: string): string[] | null {
  const open = signature.indexOf('(');
  if (open === -1) return null;

  let depth = 0;
  let close = -1;
  for (let i = open; i < signature.length; i++) {
    const ch = signature[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return null;

  const inner = signature.slice(open + 1, close).trim();
  if (inner === '') return [];

  const params: string[] = [];
  let nesting = 0;
  let current = '';
  for (const ch of inner) {
    if (ch === '(' || ch === '<' || ch === '{' || ch === '[') nesting++;
    else if (ch === ')' || ch === '>' || ch === '}' || ch === ']') nesting--;
    if (ch === ',' && nesting === 0) {
      params.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim() !== '') params.push(current.trim());
  return params;
}

/**
 * True for `name?: T`, `...rest: T[]`, and `name: T = default`.
 *
 * The `?` must be found before the *top-level* colon. A naive search finds
 * `errorMap?:` inside a nested options object and misclassifies a required
 * parameter as optional.
 */
function isOptionalParam(param: string): boolean {
  const trimmed = param.trim();
  if (trimmed.startsWith('...')) return true;

  let nesting = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '(' || ch === '<' || ch === '{' || ch === '[') nesting++;
    else if (ch === ')' || ch === '>' || ch === '}' || ch === ']') nesting--;
    else if (ch === ':' && nesting === 0) {
      return trimmed.slice(0, i).trim().endsWith('?');
    }
  }
  return trimmed.endsWith('?');
}

/** Parameters a caller must supply. Null when the signature isn't callable. */
export function requiredArity(signature: string): number | null {
  const params = parameterList(signature);
  if (params === null) return null;
  return params.filter((p) => !isOptionalParam(p)).length;
}

export function diffSurfaces(from: ApiSurface, to: ApiSurface): SurfaceDiff {
  const changes: SurfaceChange[] = [];
  const notes: string[] = [];

  const unanalyzable = from.entry === null || to.entry === null;
  if (from.entry === null) {
    notes.push(`${from.pkg}@${from.version} ships no type declarations`);
  }
  if (to.entry === null) {
    notes.push(`${to.pkg}@${to.version} ships no type declarations`);
  }

  // A truncated surface cannot support absence claims. If the *new* surface was
  // cut short, a symbol missing from it may simply be past the cutoff — reporting
  // that as a removal would invent breaking changes that do not exist.
  const suppressRemovals = Boolean(to.truncated) || unanalyzable;
  const suppressAdditions = Boolean(from.truncated) || unanalyzable;
  if (to.truncated) {
    notes.push(
      `${to.pkg}@${to.version} surface was truncated; removals are not reported`,
    );
  }
  if (from.truncated) {
    notes.push(
      `${from.pkg}@${from.version} surface was truncated; additions are not reported`,
    );
  }

  if (!unanalyzable) {
    for (const [path, before] of Object.entries(from.symbols)) {
      // A path absent from `symbols` may still be reachable through an alias.
      //
      // The surface walk claims each symbol under the first path that reaches
      // it and records other spellings in `aliases`. So when a package converts
      // a direct export into an aliased re-export — `export { Root }` becoming
      // `export { Avatar as Root }`, which @radix-ui/react-avatar did between
      // 1.1.11 and 1.2.6 — `Avatar` claims the symbol and `Root` moves to
      // `aliases`. Consulting only `symbols` then reports `Root` as removed,
      // with high confidence, about a package that still exports it. That
      // produced a pull request for a migration nobody needed.
      const after = to.symbols[path] ?? to.symbols[to.aliases[path] ?? ''];

      if (!after) {
        if (suppressRemovals) continue;
        changes.push({
          path,
          kind: 'removed',
          severity: 'breaking',
          confidence: 'high',
          before: before.signature,
          after: null,
        });
        continue;
      }

      if (!before.deprecated && after.deprecated) {
        changes.push({
          path,
          kind: 'deprecated',
          severity: 'deprecation',
          confidence: 'high',
          before: before.signature,
          after: after.signature,
        });
        // A symbol can be both newly deprecated and re-signatured; fall through
        // so the signature change is also recorded.
      }

      if (before.signature !== after.signature) {
        const beforeRequired = requiredArity(before.signature);
        const afterRequired = requiredArity(after.signature);
        const gainedRequiredParam =
          beforeRequired !== null &&
          afterRequired !== null &&
          afterRequired > beforeRequired;

        changes.push({
          path,
          kind: 'signature-changed',
          severity: 'breaking',
          // A new *required* parameter is unambiguously breaking. Any other
          // signature edit might be a widening (safe) or a narrowing (breaking);
          // string comparison alone cannot tell, so it stays medium and is never
          // auto-applied without verification.
          confidence: gainedRequiredParam ? 'high' : 'medium',
          before: before.signature,
          after: after.signature,
        });
      }
    }

    if (!suppressAdditions) {
      for (const [path, after] of Object.entries(to.symbols)) {
        if (from.symbols[path]) continue;
        changes.push({
          path,
          kind: 'added',
          severity: 'feature',
          confidence: 'high',
          before: null,
          after: after.signature,
        });
      }
    }
  }

  return {
    pkg: from.pkg,
    fromVersion: from.version,
    toVersion: to.version,
    changes,
    unanalyzable,
    ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
  };
}

function majorOf(version: string): number {
  return Number.parseInt(version.split('.')[0] ?? '0', 10) || 0;
}

/**
 * Changes that should be shown to a consumer, in the order a human should read
 * them.
 *
 * The signature-change filter is the difference between a usable report and an
 * unusable one. Comparing normalised type text catches real breaks, but it also
 * fires on every symbol whose internals were rewritten without its contract
 * changing. Across a major version that is almost everything: scanning a zod
 * 3.22 -> 4.4 upgrade produced 2,100+ "breaking" signature changes, essentially
 * all of them noise (`z.ZodString.min` was flagged, and it is fine).
 *
 * So the bar moves with the version distance:
 *
 *  - same major: a signature change is unusual and probably deliberate -> report
 *  - major jump: demand the one signal we can actually trust, a newly *required*
 *    parameter (`confidence: 'high'`), and drop the rest
 *
 * Removals and deprecations are unaffected — those are high-confidence in both
 * directions and are the findings that carry the product.
 */
export function consumerImpacting(diff: SurfaceDiff): SurfaceChange[] {
  const majorJump = majorOf(diff.toVersion) > majorOf(diff.fromVersion);
  const rank: Record<string, number> = { breaking: 0, deprecation: 1, feature: 2, safe: 3 };

  return diff.changes
    .filter((c) => {
      if (c.kind === 'removed') return true;
      if (c.kind === 'deprecated') return true;
      if (c.kind === 'signature-changed') {
        return majorJump ? c.confidence === 'high' : true;
      }
      return false;
    })
    .sort((a, b) => {
      const bySeverity = (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9);
      if (bySeverity !== 0) return bySeverity;
      // Shallower paths first: `z.record` before `z.core.util.assertEqual`.
      return a.path.split('.').length - b.path.split('.').length;
    });
}
