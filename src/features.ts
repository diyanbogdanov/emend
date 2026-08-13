/**
 * Capability that arrived while nobody was reading the changelog.
 *
 * The problem this project was built for has two halves. One is breakage, which
 * is the rest of this codebase. The other is that *useful features quietly
 * launch and go unnoticed*, and until now npm answered it barely at all:
 * `diffSurfaces` has always emitted a change per new symbol — `kind: 'added'`,
 * `severity: 'feature'` — and `consumerImpacting` has always dropped every one
 * of them.
 *
 * That filter is right for its own purpose. Its output feeds call-site
 * matching, and a symbol absent from your code has no call sites to match. The
 * defect was that nothing else ever looked.
 *
 * Kept deliberately weak, for the reason `freshness.ts` states in its own
 * header: additions are unbounded, every upgrade has some, and pouring them in
 * beside proven findings inverts the signal-to-noise ratio that makes a scan
 * worth sharing. So they carry their own severity, stay out of the headline,
 * and are capped rather than exhaustive.
 */

import { createHash } from 'node:crypto';
import type { Finding, SurfaceChange } from './types.ts';

/**
 * How many new exports a finding names before it starts counting instead.
 *
 * Five is a list; twelve is a wall somebody scrolls past. The remainder is
 * always stated — the same shape as `unlocatedBreaking`, and for the same
 * reason: a truncated list that does not say it was truncated reads as
 * complete.
 */
export const FEATURES_SHOWN = 5;

export interface PackageAdditions {
  pkg: string;
  fromVersion: string;
  toVersion: string;
  /**
   * The surface diff's changes, unfiltered.
   *
   * Filtered here rather than by the caller. A caller that forgets turns a
   * breaking change into a suggestion, which is the worst direction for this
   * particular mistake to go.
   */
  added: ReadonlyArray<SurfaceChange>;
}

function featureId(pkg: string, from: string, to: string): string {
  return createHash('sha256').update(`feature|${pkg}|${from}|${to}`).digest('hex').slice(0, 12);
}

/**
 * Declarations that are a capability rather than a shape.
 *
 * A value is something you can call, construct or read; a type is something you
 * could already have written yourself. Both are exports and only one is news.
 *
 * `unknown` is in the list deliberately. An absent or unclassified kind means
 * the extractor did not know, and dropping those would invert the cardinal
 * rule: *not known to be a type* is not *known to be a type*.
 */
const CAPABILITY_KINDS = new Set(['function', 'class', 'variable', 'enum', 'unknown']);

/**
 * Whether a new symbol is a capability or an implementation detail.
 *
 * Two structural filters, neither of them a relevance score — Emend can prove a
 * symbol is new, not that it is wanted, and a scored guess would be a changelog
 * with extra steps.
 *
 * **Depth.** `useSuspenseQuery` is something a person could decide to adopt;
 * `core.util.assertEqual` is internal machinery that happened to become
 * visible, and a release that reorganises its internals would produce dozens.
 *
 * **Kind.** Measured on the first real run: react-query 4 -> 5 reported
 * `AnyDataTag, AnyUseBaseQueryOptions, AnyUseInfiniteQueryOptions,
 * AnyUseMutationOptions, AnyUseQueryOptions and 80 more` — five type-level
 * helpers for someone else's generics, alphabetically first, while the hook the
 * release was actually about sat unnamed in the remainder.
 */
function topLevel(change: SurfaceChange): boolean {
  return (
    change.kind === 'added' &&
    !change.path.includes('.') &&
    CAPABILITY_KINDS.has(change.symbolKind ?? 'unknown')
  );
}

/**
 * Narrow a surface diff to what a feature finding could ever use, at once.
 *
 * For the caller's memory, not for correctness — `featureFindings` filters
 * again and must keep doing so. Every analysed package's changes stay live for
 * the whole scan, and an addition carries the new signature text, which is most
 * of a surface's footprint (the same reason `analyze.ts` keeps surfaces
 * `withoutSignatures`). A release that adds three thousand nested symbols would
 * otherwise be held in full to report none of them.
 */
export function newExports(changes: ReadonlyArray<SurfaceChange>): SurfaceChange[] {
  return changes.filter(topLevel).map((c) => ({ ...c, after: null }));
}

/**
 * One finding per package that gained something, never one per symbol.
 *
 * A repository with twenty dependencies gets at most twenty of these, however
 * large the releases were. Per-symbol findings would make the count a property
 * of how much the ecosystem shipped this quarter.
 */
export function featureFindings(packages: ReadonlyArray<PackageAdditions>): Finding[] {
  const found: Finding[] = [];

  for (const p of packages) {
    const names = p.added.filter(topLevel).map((c) => c.path).sort();
    if (names.length === 0) continue;

    const shown = names.slice(0, FEATURES_SHOWN);
    const hidden = names.length - shown.length;

    found.push({
      id: featureId(p.pkg, p.fromVersion, p.toVersion),
      detector: 'features',
      pkg: p.pkg,
      fromVersion: p.fromVersion,
      toVersion: p.toVersion,
      change: {
        path: p.pkg,
        kind: 'added',
        severity: 'feature',
        // The symbol is in the new surface or it is not; there is nothing here
        // for string comparison to be unsure about. What Emend is not claiming
        // is that it is useful, and confidence is the wrong field to say that
        // in — the guidance says it instead.
        confidence: 'high',
        before: null,
        after: `${names.length} new top-level export(s)`,
        guidance:
          `${p.pkg}@${p.toVersion} adds ${shown.join(', ')}` +
          (hidden > 0 ? ` and ${hidden} more` : '') +
          `. Available, not required — nothing in this repository is affected either way.`,
      },
      // No call site, and deliberately so — the freshness precedent exactly.
      // The claim is that this exists now, not that anything uses it. Somewhere
      // to point would say the opposite of what the finding means.
      sites: [],
      confidence: 'high',
    });
  }

  return found;
}
