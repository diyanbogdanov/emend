/**
 * What Emend can actually do for an ecosystem, asked of the registries rather
 * than declared.
 *
 * Derived, so it cannot drift: a language absent from the surface registry
 * reports `surface: false` because it *is* absent, not because a list somewhere
 * says so. The scan's coverage line is the product's central claim — a summary
 * that cannot be wrong about its own coverage is the only kind worth reading —
 * so the thing that renders it must not be a second source of truth.
 */

import { inventoryFor } from './ecosystems.ts';
import { clientFor } from './registry.ts';
import { extractorFor } from './surface.ts';
import { resolverForEcosystem } from './callsites.ts';

export interface Capabilities {
  inventory: boolean;
  registry: boolean;
  surface: boolean;
  callSites: boolean;
}

/**
 * What Emend can do for `ecosystem`, read live off each seam's own registry
 * rather than a list kept here.
 *
 * Each field is `!== undefined` against the matching seam's lookup, never a
 * bare `!lookup(...)`. The lookups return the adapter itself, and collapsing
 * that through `!` is exactly the kind of shortcut that would make this
 * function the second source of truth the module doc argues against.
 */
export function capabilitiesFor(ecosystem: string): Capabilities {
  return {
    inventory: inventoryFor(ecosystem) !== undefined,
    registry: clientFor(ecosystem) !== undefined,
    surface: extractorFor(ecosystem) !== undefined,
    callSites: resolverForEcosystem(ecosystem) !== undefined,
  };
}

/** Plain-English name for each tier, in the order `describeCoverage` reports them. */
const TIER_LABEL: Record<keyof Capabilities, string> = {
  inventory: 'dependency inventory',
  registry: 'registry lookups',
  surface: 'API surface extraction',
  callSites: 'call-site search',
};

/** Why a tier is missing, for whichever ecosystem `describeCoverage` names. */
const TIER_REASON: Record<keyof Capabilities, string> = {
  inventory: "no adapter reads this ecosystem's dependency tree",
  registry: 'no client resolves its package versions',
  surface: "no extractor reads a package's public API",
  callSites: 'no resolver searches source for its call sites',
};

const TIERS = Object.keys(TIER_LABEL) as (keyof Capabilities)[];

/**
 * One line per ecosystem, naming what this scan actually did — not merely
 * what Emend is capable of.
 *
 * `capabilitiesFor` answers "is an adapter registered for this ecosystem?",
 * which is a fact about the codebase, true whether or not this particular
 * scan found a single package to run those adapters on. Rendering that fact
 * as "fully examined ... all ran" regardless of what happened was exactly the
 * bug this parameter exists to close: a repository whose dependencies were
 * all unresolved ranges hit that sentence having analysed zero packages.
 * `analyzed` — the same count already printed on the line above this one —
 * is what tells "registered" and "ran" apart.
 *
 * Phrased so silence never reads as a clean result: an unexamined tier is
 * named as unexamined, with the reason, rather than omitted; an ecosystem
 * with every tier registered but nothing for them to run on says so plainly
 * rather than borrowing the sentence meant for the case that actually ran.
 */
export function describeCoverage(ecosystem: string, analyzed: number): string {
  const caps = capabilitiesFor(ecosystem);
  const missing = TIERS.filter((tier) => !caps[tier]);

  if (missing.length > 0) {
    const gaps = missing
      .map((tier) => `${TIER_LABEL[tier]} not examined (${TIER_REASON[tier]})`)
      .join(', ');
    return `${ecosystem}: ${gaps}.`;
  }

  // Every tier is registered. Whether any of them actually ran on something
  // is the separate question capabilities alone cannot answer — see above.
  if (analyzed === 0) {
    return `${ecosystem}: no dependencies were analysed.`;
  }

  return `${ecosystem}: examined ${analyzed} package(s) — ${TIERS.map((t) => TIER_LABEL[t]).join(', ')} all ran.`;
}
