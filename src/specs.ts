/**
 * Finding an API description, and deciding what it entitles Emend to say.
 *
 * A raw `fetch` has no `.d.ts`, so the only surface an HTTP call can be diffed
 * against is a published API description. The hard part is not parsing one — it
 * is knowing whether the copy in hand is the provider's or somebody's snapshot
 * of it, because a difference between two versions of a stale mirror is as
 * likely to be the mirror as the API.
 *
 * So provenance is not metadata attached to a spec. It decides what may be
 * claimed from it, the same way `InstalledDependency.source` decides whether a
 * version may arbitrate a Dockerfile conflict: a version guessed from a range is
 * not a fact about the repository, and a spec copied from an unmaintained
 * directory is not a fact about the API.
 *
 * The distinction that organises all of this is **discovery source versus truth
 * source**. Directories and registries are excellent for finding that an API
 * exists and where its description lives. Once found, resolution walks back
 * toward something the provider controls, and Emend's claims are bounded by how
 * far back it got.
 */

/**
 * Where a description came from, ordered by how close it sits to the provider.
 *
 * `aggregator-apis-guru` is called out by name rather than folded into a general
 * "aggregator" bucket: its README still advertises weekly refreshes while the
 * corpus is no longer actively maintained, which makes it a good bootstrap and a
 * bad authority. Naming it keeps that judgement visible at the point of use.
 */
export type SpecProvenance =
  | 'official-domain'
  | 'official-github'
  | 'verified-swaggerhub'
  | 'verified-postman'
  | 'curated'
  | 'aggregator-apis-guru'
  | 'community'
  | 'extracted-from-docs';

/**
 * Confidence, on the scale the ranking was designed against.
 *
 * The numbers matter less than the boundary at 90: at or above it the provider
 * controls or has verified the description, and below it somebody else is
 * holding a copy.
 */
export const PROVENANCE_RANK: Record<SpecProvenance, number> = {
  'official-domain': 100,
  'official-github': 95,
  'verified-swaggerhub': 90,
  'verified-postman': 85,
  curated: 75,
  'aggregator-apis-guru': 60,
  community: 50,
  'extracted-from-docs': 30,
};

/** The line above which a description is the provider's word rather than a copy. */
const AUTHORITATIVE = 90;

export interface SpecCandidate {
  vendor: string;
  url: string;
  provenance: SpecProvenance;
  /** When this copy was obtained, which is the only staleness signal a mirror gives. */
  fetchedAt: string;
  /** The description itself, once fetched. */
  body?: string;
}

/**
 * The candidate closest to the provider.
 *
 * Ties keep the first, so callers can express a preference within a tier by the
 * order they supply candidates.
 */
export function bestSpec(candidates: SpecCandidate[]): SpecCandidate | undefined {
  let best: SpecCandidate | undefined;
  for (const candidate of candidates) {
    if (!best || PROVENANCE_RANK[candidate.provenance] > PROVENANCE_RANK[best.provenance]) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Whether a finding derived from this description may assert that a call breaks.
 *
 * Below the line Emend can still say what it found — these call sites reach this
 * endpoint, this is the description it located and where from — and must not say
 * the call is broken. Telling somebody their Stripe integration breaks on the
 * strength of a copy that may be a year stale is the false certainty every
 * honesty rule here exists to prevent, and it is indistinguishable to the reader
 * from a real finding.
 *
 * A Postman collection sits below the line for a different reason: it carries
 * real working requests, which makes it excellent for discovery and examples,
 * and it is not a complete description of the API. An endpoint missing from one
 * says nothing about whether the endpoint exists.
 */
export function canAssertBreakage(candidate: SpecCandidate): boolean {
  return PROVENANCE_RANK[candidate.provenance] >= AUTHORITATIVE;
}

/**
 * Paths worth trying on a provider's own origin when nothing has pointed us at a
 * description.
 *
 * Deliberately a short fixed list on the origin itself. Crawling a documentation
 * site to synthesise a description is a real technique and a different tier of
 * confidence — `extracted-from-docs` exists for it — and it does not belong in
 * the same step as reading a file the provider published.
 */
const WELL_KNOWN = [
  '/openapi.json',
  '/openapi.yaml',
  '/swagger.json',
  '/swagger.yaml',
  '/api/openapi.json',
  '/api/swagger.json',
  '/.well-known/openapi.json',
  '/.well-known/api-description',
];

export function wellKnownSpecPaths(origin: string): string[] {
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    // A malformed origin yields nothing rather than a malformed request.
    return [];
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') return [];
  return WELL_KNOWN.map((p) => new URL(p, base.origin).toString());
}

/** One line per candidate, for a finding's evidence. */
export function describeProvenance(candidate: SpecCandidate): string {
  const rank = PROVENANCE_RANK[candidate.provenance];
  const claim = canAssertBreakage(candidate)
    ? 'provider-controlled, so a mismatch is evidence'
    : 'a third-party copy, so a mismatch is a lead and not a finding';
  return `${candidate.url} — ${candidate.provenance} (${rank}/100): ${claim}`;
}
