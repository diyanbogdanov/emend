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
 * `directory` sits above the platforms that host copies because a directory
 * holds *addresses*, not files. An APIs.json manifest is published by the
 * provider, and an apis.io listing points wherever the provider said — where
 * SwaggerHub and Postman hold somebody else's bytes on somebody else's platform,
 * verified account or not. A pointer to the provider beats a copy of the
 * provider, and when it lands on the provider `provenanceOfPointer` says so and
 * this tier never applies. What is left is the residual case the tier is for:
 * listed by a directory, hosted somewhere the provider does not control.
 *
 * Named for what it is rather than for one directory: it is reached from an
 * apis.io listing and from an APIs.json entry pointing off-domain, and any
 * future directory lands here too.
 *
 * There is no aggregator tier. apis.guru held one until its weekly refresh
 * stopped running in March while its README went on advertising one — and a
 * source that claims to be current when it is not is worse than no source,
 * because it makes a stale description look like a checked one. Nothing else
 * currently mirrors descriptions at that scale, so the tier went with it.
 */
export type SpecProvenance =
  | 'official-domain'
  | 'official-github'
  | 'directory'
  | 'verified-swaggerhub'
  | 'verified-postman'
  | 'curated'
  | 'community'
  | 'extracted-from-docs';

/**
 * Which candidate to prefer when several describe the same API.
 *
 * Preference only. What a candidate entitles Emend to *say* is a separate
 * question, answered by `PROVIDER_CONTROLLED`, and the two are deliberately not
 * the same number — see `canAssertBreakage`.
 */
export const PROVENANCE_RANK: Record<SpecProvenance, number> = {
  'official-domain': 100,
  'official-github': 95,
  directory: 92,
  'verified-swaggerhub': 90,
  'verified-postman': 85,
  curated: 75,
  community: 50,
  'extracted-from-docs': 30,
};

/**
 * The provenances under which the provider wrote or vouched for the description.
 *
 * An explicit set rather than a cutoff on `PROVENANCE_RANK`, because the two
 * orderings genuinely differ: a directory that points at third-party bytes is
 * the best *route* to try and still not the provider's word. A cutoff makes
 * every future reorder of the preference list silently hand out claim rights,
 * which is precisely the kind of quiet widening this file exists to prevent.
 */
const PROVIDER_CONTROLLED: ReadonlySet<SpecProvenance> = new Set([
  'official-domain',
  'official-github',
  'verified-swaggerhub',
]);

export interface SpecCandidate {
  vendor: string;
  url: string;
  provenance: SpecProvenance;
  /** When Emend obtained this copy. Says nothing about the description's own age. */
  fetchedAt: string;
  /**
   * When the provider last changed the description, where that can be known.
   *
   * Deliberately separate from `fetchedAt`, which was doing duty as a staleness
   * signal and is not one: a copy pulled today out of a repository abandoned in
   * 2020 has a `fetchedAt` of today. Absent means *not known*, which
   * `canAssertBreakage` treats as not current rather than as current.
   */
  updatedAt?: string;
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
export function canAssertBreakage(candidate: SpecCandidate, now: number = Date.now()): boolean {
  if (!PROVIDER_CONTROLLED.has(candidate.provenance)) return false;
  return SERVED_LIVE.has(candidate.provenance) || isCurrent(candidate, now);
}

/**
 * The provenances whose currency the fetch itself establishes.
 *
 * A file at the provider's own origin is what they are serving as their
 * description *now*, so retrieving it is the evidence that they still mean it.
 * A file in a repository or on a platform is a committed artifact that keeps
 * resolving long after anyone stopped maintaining it, and only its own last
 * change says which of the two it is.
 */
const SERVED_LIVE: ReadonlySet<SpecProvenance> = new Set(['official-domain']);

/**
 * How long a stored copy may go untouched and still be evidence about today.
 *
 * Measured rather than rounded to a comfortable number. Across the descriptions
 * Emend resolved for real vendors, every maintained one had changed within 95
 * days — Twilio 95, Webflow 74, Box and Asana 9, GitHub, Discord, Deepgram and
 * Runway inside three — and the one abandoned description, Slack's, had not
 * changed in 2,132. There is a factor of twenty-two between the two groups, and
 * a year sits between them with margin both ways — nearly four times the
 * slowest maintained cadence, less than a fifth of the abandoned gap: loose
 * enough that a quiet quarter is not an accusation, tight enough that five dead
 * years cannot pass as the provider's current word.
 */
export const CURRENCY_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Whether a stored copy is known to be recent enough to speak for today's API.
 *
 * An unknown date is not a recent one. Emend asked and could not find out, and
 * rendering that as current is the same error as reporting an unreadable call
 * as a clean one — with a worse consequence, because the finding it licences
 * looks exactly like a real one.
 */
export function isCurrent(candidate: SpecCandidate, now: number = Date.now()): boolean {
  if (!candidate.updatedAt) return false;
  const changed = Date.parse(candidate.updatedAt);
  if (Number.isNaN(changed)) return false;
  return now - changed <= CURRENCY_WINDOW_MS;
}

/**
 * Organisations an operator has named, each for the vendor they named it for.
 *
 * `domain=org`, comma separated. A single organisation applied to every vendor
 * is not merely useless for the others, it is unsafe: `githubSpecUrls` skips
 * discovery when an organisation is given, so a scan of Twilio with `stripe`
 * named would search Stripe's repositories, and `provenanceOfPointer` credits a
 * github.com URL whose first path segment equals the named organisation. A
 * Stripe description would be recorded as Twilio's own word, at 95/100, licensed
 * to assert that somebody's integration is broken.
 *
 * A bare value is refused rather than guessed at. Reading it as "for every
 * vendor" is the unsafe reading, and ignoring it would drop something the
 * operator meant.
 */
export function githubOrgs(flag: string): Map<string, string> {
  const orgs = new Map<string, string>();
  for (const pair of flag.split(',')) {
    const trimmed = pair.trim();
    if (trimmed === '') continue;
    const [domain, org] = trimmed.split('=');
    if (!domain || !org) {
      throw new Error(
        `--github-org expects domain=org pairs, e.g. stripe.com=stripe; got "${trimmed}"`,
      );
    }
    orgs.set(domain.trim().toLowerCase(), org.trim());
  }
  return orgs;
}

/**
 * The organisation named for this host, if one was.
 *
 * A call site reaches `api.stripe.com` while an operator names `stripe.com`, so
 * the host is matched against the domains named and everything under them.
 */
export function orgFor(host: string, orgs: Map<string, string>): string | undefined {
  const lower = host.toLowerCase();
  for (const [domain, org] of orgs) if (isUnder(lower, domain)) return org;
  return undefined;
}

/** Whether `host` is `domain` or something under it — `api.stripe.com` for `stripe.com`. */
function isUnder(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

const GITHUB_HOSTS = ['github.com', 'raw.githubusercontent.com', 'gist.githubusercontent.com'];

/**
 * What a directory entry is worth once its pointer is followed.
 *
 * A directory does not hold descriptions, it holds addresses, so its listing
 * says where to look and the address says whose file it is. When apis.io points
 * at the provider's own domain the candidate *is* the provider's file, and the
 * route it arrived by neither adds to that nor takes from it. Only the residual
 * case — listed, but hosted somewhere the provider does not control — keeps the
 * directory's own standing.
 *
 * `vendorOrg` is required to credit a GitHub URL, because anyone may host a
 * mirror there; without it a github.com address is just an address.
 */
export function provenanceOfPointer(
  url: string,
  vendorDomain: string,
  vendorOrg?: string,
): SpecProvenance {
  let host: string;
  let path: string;
  try {
    const parsed = new URL(url);
    host = parsed.hostname.toLowerCase();
    path = parsed.pathname;
  } catch {
    return 'directory';
  }

  if (isUnder(host, vendorDomain.toLowerCase())) return 'official-domain';

  if (vendorOrg && GITHUB_HOSTS.includes(host)) {
    const org = path.split('/').filter(Boolean)[0];
    if (org?.toLowerCase() === vendorOrg.toLowerCase()) return 'official-github';
  }

  return 'directory';
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
  // Framework defaults, which are the ones that actually land. Guessing a
  // hand-written path on an origin almost never works — measured against four
  // real vendors, it found nothing — but nobody moves the path their framework
  // generates. springfox, ASP.NET, and the Swagger UI convention respectively.
  '/v2/api-docs',
  '/v3/api-docs',
  '/swagger/v1/swagger.json',
  '/api-docs',
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

export interface SpecSource {
  id: 'well-known' | 'github' | 'apis-io' | 'swaggerhub' | 'postman';
  /** What a hit is worth before any pointer it carries has been followed. */
  yields: SpecProvenance;
}

/**
 * The order to consult sources in, best route first.
 *
 * Distinct from `PROVENANCE_RANK`, which compares candidates already in hand.
 * This decides what to try, and trying the cheapest route that tends to land on
 * the provider avoids fetching a copy that would then have to be discounted.
 */
export const SPEC_SOURCES: readonly SpecSource[] = [
  // The provider's own origin. Nothing is closer, and it costs one request.
  { id: 'well-known', yields: 'official-domain' },
  // The provider's own repository, where most specs that are versioned live.
  { id: 'github', yields: 'official-github' },
  // The directory: one manifest per provider, listing descriptions, docs,
  // changelogs and the rest. For anything published after about 2022 it is the
  // only index that has heard of it.
  { id: 'apis-io', yields: 'directory' },
  // Platforms holding copies, in order of how firmly the account is tied to the
  // provider. Postman is last of the two because a collection is not a contract.
  { id: 'swaggerhub', yields: 'verified-swaggerhub' },
  { id: 'postman', yields: 'verified-postman' },
];

/**
 * Why this candidate does or does not entitle Emend to speak.
 *
 * Names the actual reason rather than one stock reason for everything refused:
 * a spec can now be turned down for being somebody else's copy *or* for being
 * the provider's own file that nobody has touched in five years, and a reader
 * who is told "a third-party copy" about GitHub-hosted, first-party Slack
 * Swagger has been told something false.
 */
export function describeProvenance(candidate: SpecCandidate, now: number = Date.now()): string {
  const rank = PROVENANCE_RANK[candidate.provenance];
  return `${candidate.url} — ${candidate.provenance} (${rank}/100): ${claimOf(candidate, now)}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function claimOf(candidate: SpecCandidate, now: number): string {
  if (!PROVIDER_CONTROLLED.has(candidate.provenance)) {
    return 'a third-party copy, so a mismatch is a lead and not a finding';
  }
  if (SERVED_LIVE.has(candidate.provenance)) {
    return 'provider-controlled and served from their own origin, so a mismatch is evidence';
  }

  const changed = candidate.updatedAt ? Date.parse(candidate.updatedAt) : Number.NaN;
  if (Number.isNaN(changed)) {
    return 'provider-controlled, but when they last changed it could not be established, so a mismatch is a lead and not a finding';
  }

  const days = Math.round((now - changed) / DAY_MS);
  return isCurrent(candidate, now)
    ? `provider-controlled and last changed ${days} day(s) ago, so a mismatch is evidence`
    : `provider-controlled but last changed ${days} day(s) ago, so it is not evidence about today's API`;
}
