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
 * One line per ecosystem, naming the tiers that did not run.
 *
 * Phrased so silence never reads as a clean result: an unexamined tier is named
 * as unexamined, with the reason, rather than omitted.
 */
export function describeCoverage(ecosystem: string): string {
  const caps = capabilitiesFor(ecosystem);
  const missing = TIERS.filter((tier) => !caps[tier]);

  if (missing.length === 0) {
    return `${ecosystem}: fully examined — ${TIERS.map((t) => TIER_LABEL[t]).join(', ')} all ran.`;
  }

  const gaps = missing
    .map((tier) => `${TIER_LABEL[tier]} not examined (${TIER_REASON[tier]})`)
    .join(', ');
  return `${ecosystem}: ${gaps}.`;
}
