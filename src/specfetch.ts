/**
 * Going and finding an API description, and being honest about what came back.
 *
 * `specs.ts` decides what a description entitles Emend to say. This decides
 * which descriptions exist and fetches them, in the order that most often lands
 * closest to the provider: their own origin, then the manifest they publish
 * saying where their descriptions live, then the aggregators.
 *
 * Two rules run through all of it.
 *
 * **Provenance follows the bytes, never the request.** Asking `acme.com` and
 * being answered by a CDN means the answer is the CDN's, whatever was hoped for,
 * so provenance is derived from the URL that actually served the response.
 *
 * **A 200 is not a spec.** The common shape of a wrong guess is a well-known
 * path that does not exist, answered by a catch-all route with the marketing
 * site and a cheerful status code. Every body is checked for the thing it claims
 * to be before it becomes a candidate.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  PROVENANCE_RANK,
  provenanceOfPointer,
  wellKnownSpecPaths,
  type SpecCandidate,
  type SpecProvenance,
} from './specs.ts';

export interface FetchResponse {
  ok: boolean;
  status: number;
  /** The URL that served this, after any redirect. The only one provenance may use. */
  url: string;
  body: string;
  contentType: string;
}

/**
 * Injected rather than called directly, so the resolution order and the
 * acceptance rules are testable without a network.
 */
export type Fetcher = (url: string) => Promise<FetchResponse>;

export interface Vendor {
  /** The provider's own domain, e.g. `stripe.com`. */
  domain: string;
  /** Their GitHub org, when known. Required before a GitHub URL can be credited. */
  org?: string;
}

export interface ResolveOptions {
  fetch: Fetcher;
  cacheDir: string;
  /** How long a cached copy stays usable. A day by default. */
  maxAgeMs?: number;
}

type Doc = Record<string, unknown>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Above this, a body is not being read as an API description by anybody. */
const MAX_SPEC_BYTES = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Is this actually a description?
// ---------------------------------------------------------------------------

/**
 * Whether a body is an API description rather than something that merely
 * arrived with a 200.
 *
 * Structural, not by content type: a content type is a claim the server makes,
 * and `{"error":"not found"}` is perfectly good JSON describing no API at all.
 * What makes a document an OpenAPI or Swagger description is the version key and
 * a `paths` object, so that is what is looked for.
 */
export function looksLikeSpec(body: string): boolean {
  if (body.length === 0 || body.length > MAX_SPEC_BYTES) return false;
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    // YAML is legitimate and not parsed here. Rather than guess at it with a
    // regex, treat it as unrecognised: a spec Emend cannot read is one it must
    // not claim to have checked.
    return false;
  }
  if (typeof doc !== 'object' || doc === null) return false;
  const d = doc as Record<string, unknown>;
  const versioned = typeof d['openapi'] === 'string' || typeof d['swagger'] === 'string';
  const hasPaths = typeof d['paths'] === 'object' && d['paths'] !== null;
  return versioned && hasPaths;
}

/** The spec URLs an APIs.json manifest points at, in the order it lists them. */
export function specUrlsInManifest(body: string): string[] {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return [];
  }
  const apis = (doc as { apis?: unknown })?.apis;
  if (!Array.isArray(apis)) return [];

  const urls: string[] = [];
  for (const api of apis) {
    const props = (api as { properties?: unknown })?.properties;
    if (!Array.isArray(props)) continue;
    for (const prop of props) {
      const p = prop as { type?: unknown; url?: unknown };
      if (typeof p.type !== 'string' || typeof p.url !== 'string') continue;
      // APIs.json spells the same thing several ways depending on its vintage.
      if (/^(swagger|openapi|x-openapi|apis?-?spec)$/i.test(p.type)) urls.push(p.url);
    }
  }
  return urls;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  url: string;
  provenance: SpecProvenance;
  fetchedAt: string;
  body: string;
}

function cacheKey(vendor: Vendor): string {
  return createHash('sha256').update(`${vendor.domain}\0${vendor.org ?? ''}`).digest('hex').slice(0, 32);
}

async function readCache(
  dir: string,
  vendor: Vendor,
  maxAgeMs: number,
  now: number,
): Promise<SpecCandidate[] | null> {
  const file = path.join(dir, `${cacheKey(vendor)}.json`);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  let entries: CacheEntry[];
  try {
    entries = JSON.parse(raw) as CacheEntry[];
  } catch {
    return null;
  }
  if (!Array.isArray(entries) || entries.length === 0) return null;

  // One stale entry invalidates the set rather than half of it, so a resolution
  // never mixes copies taken days apart and calls the difference an API change.
  for (const entry of entries) {
    const age = now - Date.parse(entry.fetchedAt);
    // `>=`, so a lifetime of zero means exactly what it says: never reuse.
    if (!Number.isFinite(age) || age >= maxAgeMs) return null;
  }
  return entries.map((e) => ({ vendor: vendor.domain, ...e }));
}

async function writeCache(dir: string, vendor: Vendor, found: SpecCandidate[]): Promise<void> {
  // Only successes. Caching an absence would turn one bad afternoon on someone's
  // CDN into a lasting belief that an API has no description at all.
  //
  // `readCache` rejects an empty entry list as well, so the property survives
  // either of these alone. This one is here to skip the pointless write, which
  // in a service scanning many vendors is a file per failure per run.
  if (found.length === 0) return;
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, `${cacheKey(vendor)}.json`),
    JSON.stringify(found, null, 2),
    'utf8',
  );
}

/** Every vendor with something cached, for a scheduler that wants to refresh them. */
export async function cachedVendors(dir: string): Promise<string[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const vendors = new Set<string>();
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const entries = JSON.parse(await readFile(path.join(dir, file), 'utf8')) as SpecCandidate[];
      for (const entry of entries) if (entry.vendor) vendors.add(entry.vendor);
    } catch {
      continue;
    }
  }
  return [...vendors].sort();
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Fetch one URL and turn it into a candidate, or into nothing.
 *
 * `floor` is the best a hit from this source can be worth. A well-known path on
 * the provider's origin resolves by where it landed, so it passes no floor; an
 * aggregator's copy is that aggregator's whatever the URL looks like.
 */
async function candidateFrom(
  fetch: Fetcher,
  url: string,
  vendor: Vendor,
  now: string,
  floor?: SpecProvenance,
): Promise<SpecCandidate | null> {
  let res: FetchResponse;
  try {
    res = await fetch(url);
  } catch {
    return null;
  }
  if (!res.ok || !looksLikeSpec(res.body)) return null;

  return {
    vendor: vendor.domain,
    // The URL that served it, not the one that was asked for.
    url: res.url,
    // Against the registrable domain, so a description for `api.stripe.com`
    // served from `stripe.com` is still the provider's own file.
    provenance: floor ?? provenanceOfPointer(res.url, registrableDomain(vendor.domain), vendor.org),
    fetchedAt: now,
    body: res.body,
  };
}

interface AggregatorLead {
  url: string;
  /** Set only for the aggregator's own copy; a pointer is judged by where it lands. */
  floor?: SpecProvenance;
}

const APIS_IO = 'https://apis.io/api/v1';

/** Stripe alone publishes 159 APIs there; following all of them is not a resolution. */
const MAX_LISTINGS = 5;

/** `api.stripe.com` -> `stripe.com`. Good enough to check a link against. */
function registrableDomain(host: string): string {
  const parts = host.toLowerCase().split('.');
  return parts.length <= 2 ? host.toLowerCase() : parts.slice(-2).join('.');
}

/** Whether any URL in a record points at the vendor's own domain. */
function linksBackTo(record: Doc, domain: string): boolean {
  for (const value of Object.values(record)) {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) continue;
    try {
      const host = new URL(value).hostname.toLowerCase();
      if (host === domain || host.endsWith(`.${domain}`)) return true;
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * What apis.io lists for this vendor.
 *
 * The directory is keyed by a slug — `stripe` — where every call site hands us a
 * host. There is no domain field on its records to bridge that: `baseURL` and
 * `humanURL` are empty on all of them. So the slug is derived from the domain
 * and then **verified**, by requiring the provider record to link back to the
 * vendor's own domain somewhere. Attribution by guess is how one company's API
 * ends up reported as another's, and `stripe` is a plausible slug for a dozen
 * things.
 *
 * Nothing here is authoritative — its artifacts are third-party republications,
 * so `canAssertBreakage` refuses them regardless. That bounds the damage a wrong
 * slug could do, which is what makes a derived-then-checked slug acceptable at
 * all rather than a guess dressed up.
 */
async function apisIoLeads(fetch: Fetcher, domain: string): Promise<AggregatorLead[]> {
  const registrable = registrableDomain(domain);
  const slug = registrable.split('.')[0];
  if (!slug) return [];

  const json = async (url: string): Promise<Doc | null> => {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      return JSON.parse(res.body) as Doc;
    } catch {
      return null;
    }
  };

  const provider = await json(`${APIS_IO}/providers/${encodeURIComponent(slug)}`);
  // No link back to the vendor, no attribution — and no further requests.
  if (!provider || !linksBackTo(provider, registrable)) return [];

  const listing = await json(`${APIS_IO}/providers/${encodeURIComponent(slug)}/apis`);
  const data = listing?.['data'];
  if (!Array.isArray(data)) return [];

  const leads: AggregatorLead[] = [];
  for (const entry of data.slice(0, MAX_LISTINGS)) {
    const aid = (entry as Doc | undefined)?.['aid'];
    if (typeof aid !== 'string') continue;
    // The colon stays literal. `stripe:stripe-account-api` answers 200 and
    // `stripe%3Astripe-account-api` answers 404, so encoding it made every
    // detail lookup fail — silently, and while still spending the requests.
    const detail = await json(`${APIS_IO}/apis/${encodeURIComponent(aid).replace(/%3A/gi, ':')}`);
    const props = detail?.['properties'];
    if (!Array.isArray(props)) continue;
    for (const prop of props) {
      const p = prop as Doc;
      if (typeof p['type'] !== 'string' || typeof p['url'] !== 'string') continue;
      // Judged by where the pointer lands, like every other directory entry.
      if (/^(openapi|swagger)$/i.test(p['type'])) leads.push({ url: p['url'] });
    }
  }
  return leads;
}

/**
 * What apis.guru's entry for a domain points at, best route first.
 *
 * Two hops rather than one, because the description sits under a version
 * segment — `/v2/specs/stripe.com/2022-11-15/openapi.json` — that cannot be
 * guessed. The per-domain endpoint names it for about a kilobyte, against 8.8MB
 * for `list.json`.
 *
 * The reason this source earns its place is `x-origin`: the entry records where
 * the provider *actually publishes*, which for Stripe is their own GitHub
 * repository. So the aggregator can be used purely to discover, and the
 * description still comes from a first-party source — the aggregator's own copy
 * is the fallback rather than the point. Measured today, that copy is dated
 * 2022-11-15, four years stale, which is precisely why it must not be the point.
 */
async function aggregatorLeads(fetch: Fetcher, domain: string): Promise<AggregatorLead[]> {
  let res: FetchResponse;
  try {
    res = await fetch(`https://api.apis.guru/v2/${domain}.json`);
  } catch {
    return [];
  }
  if (!res.ok) return [];

  let apis: unknown;
  try {
    apis = (JSON.parse(res.body) as { apis?: unknown }).apis;
  } catch {
    return [];
  }
  if (typeof apis !== 'object' || apis === null) return [];

  const pointers: AggregatorLead[] = [];
  const mirrors: AggregatorLead[] = [];

  for (const entry of Object.values(apis as Doc)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Doc;

    const info = (typeof e['info'] === 'object' && e['info'] !== null ? e['info'] : {}) as Doc;
    const origins = info['x-origin'];
    if (Array.isArray(origins)) {
      for (const origin of origins) {
        const url = (origin as Doc | undefined)?.['url'];
        if (typeof url !== 'string') continue;
        pointers.push({ url });
        // There is no YAML reader here. Rather than lose the best pointer
        // available, its JSON sibling is tried too — and accepted only if it
        // parses as a description, which makes it a check and not a guess.
        if (/\.ya?ml$/i.test(url)) pointers.push({ url: url.replace(/\.ya?ml$/i, '.json') });
      }
    }

    if (typeof e['swaggerUrl'] === 'string') {
      mirrors.push({ url: e['swaggerUrl'], floor: 'aggregator-apis-guru' });
    }
  }

  return [...pointers, ...mirrors];
}

/**
 * Find every description of this vendor's API that can be located, best first.
 *
 * Sources are consulted in the order `SPEC_SOURCES` records, and the walk stops
 * as soon as the provider's own word is in hand: no third party's copy can
 * improve on it, so every further request is latency and somebody's rate limit
 * spent for nothing.
 *
 * An empty result means *not found*, and callers must render it that way. The
 * detector this feeds reports the call sites it located and says the spec was
 * unavailable; it never reports that there is no problem.
 *
 * SwaggerHub, Postman and GitHub are named in `SPEC_SOURCES` and are not
 * consulted here — each needs a registry search or a credential, and a stub that
 * silently finds nothing would be indistinguishable from a source that looked.
 */
export async function resolveSpec(
  vendor: Vendor,
  options: ResolveOptions,
): Promise<SpecCandidate[]> {
  const maxAge = options.maxAgeMs ?? DAY_MS;
  const clock = Date.now();
  const cached = await readCache(options.cacheDir, vendor, maxAge, clock);
  if (cached) return cached;

  const now = new Date(clock).toISOString();
  // A call site hands us a host — `api.stripe.com` — while the directories key on
  // the registrable domain. Asking apis.guru about the host returned nothing and
  // Stripe resolved to zero candidates, while asking about `stripe.com` had
  // worked all along. Both are tried, host first: that is where the API actually
  // lives, so a description served there is the more specific answer.
  const domains = [...new Set([vendor.domain.toLowerCase(), registrableDomain(vendor.domain)])];
  const found: SpecCandidate[] = [];
  const seen = new Set<string>();
  const add = (c: SpecCandidate | null): void => {
    if (c && !seen.has(c.url)) {
      seen.add(c.url);
      found.push(c);
    }
  };
  const settled = (): boolean => found.some((c) => c.provenance === 'official-domain');

  // 1. The provider's own origin. Nothing is closer and it costs one request.
  for (const domain of domains) {
    for (const url of wellKnownSpecPaths(`https://${domain}`)) {
      add(await candidateFrom(options.fetch, url, vendor, now));
      if (settled()) break;
    }
    if (settled()) break;
  }

  // 2. The manifest the provider publishes saying where its descriptions live.
  //    This is the directory idea at its strongest: an APIs.json at the
  //    provider's own domain is first-party metadata, and following it usually
  //    lands on first-party content — which is why the directory outranks the
  //    platforms that merely hold copies.
  for (const domain of domains) {
    if (settled()) break;
    let manifest: FetchResponse | null = null;
    try {
      manifest = await options.fetch(`https://${domain}/apis.json`);
    } catch {
      manifest = null;
    }
    if (!manifest?.ok) continue;
    for (const url of specUrlsInManifest(manifest.body)) {
      add(await candidateFrom(options.fetch, url, vendor, now));
      if (settled()) break;
    }
  }

  //    apis.guru, through its index entry rather than a guessed URL: the spec
  //    lives under a version segment no fixed pattern can produce, and the
  //    per-domain entry names it for one small request instead of the 8.8MB
  //    `list.json`.
  //
  //    A good bootstrap and a bad authority. Measured today, its preferred
  //    Stripe description is dated 2022-11-15 — four years old — so a difference
  //    against it is far likelier to be drift in the mirror than in the API.
  //    `specs.ts` already refuses to let it assert breakage; this only has to
  //    record the tier truthfully.
  // 3. apis.io, the directory. Consulted before the aggregator, because a
  //    directory holds addresses and an aggregator holds copies. It can never
  //    settle the walk — its listings are third-party republications, so nothing
  //    from it is the provider's own word — which is exactly why consulting it
  //    first cannot produce a worse answer than not having it: the walk carries
  //    on, and the ranking puts a first-party description in front if one turns
  //    up later.
  if (!settled()) {
    for (const lead of await apisIoLeads(options.fetch, registrableDomain(vendor.domain))) {
      add(await candidateFrom(options.fetch, lead.url, vendor, now, lead.floor));
      if (settled()) break;
    }
  }

  // 4. apis.guru, the aggregator.
  for (const domain of domains) {
    if (settled()) break;
    for (const lead of await aggregatorLeads(options.fetch, domain)) {
      add(await candidateFrom(options.fetch, lead.url, vendor, now, lead.floor));
      // A first-party pointer settles it; the mirrors after it add nothing but
      // an older copy of the same API.
      if (settled() || found.some((c) => c.provenance === 'official-github')) break;
    }
  }

  // Best first, explicitly. Until apis.io was consulted the sources happened to
  // run in descending order and `found[0]` was best by accident; every caller
  // treats it as the best, so the ordering has to be a property of the result
  // rather than of the order sources were tried in.
  const ranked = [...found].sort(
    (a, b) => PROVENANCE_RANK[b.provenance] - PROVENANCE_RANK[a.provenance],
  );
  await writeCache(options.cacheDir, vendor, ranked);
  return ranked;
}

/**
 * The real fetcher: HTTPS only, bounded, and reporting where it ended up.
 *
 * Separate from `resolveSpec` so the ordering and acceptance rules can be tested
 * without a network, and so the network policy lives in exactly one place.
 */
export function httpFetcher(options: { timeoutMs?: number } = {}): Fetcher {
  const timeoutMs = options.timeoutMs ?? 15_000;
  return async (url: string): Promise<FetchResponse> => {
    const empty = { ok: false, status: 0, url, body: '', contentType: '' };
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return empty;
    }
    // Plain HTTP would let anyone on the path decide what an API looks like.
    if (target.protocol !== 'https:') return empty;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await globalThis.fetch(target, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { accept: 'application/json, application/yaml, text/yaml, */*' },
      });
      const length = Number(res.headers.get('content-length') ?? '0');
      if (length > MAX_SPEC_BYTES) {
        return { ok: false, status: res.status, url: res.url, body: '', contentType: '' };
      }
      const body = await res.text();
      return {
        ok: res.ok,
        status: res.status,
        // `res.url` is the final URL after redirects, which is the whole point.
        url: res.url || url,
        body: body.length > MAX_SPEC_BYTES ? '' : body,
        contentType: res.headers.get('content-type') ?? '',
      };
    } catch {
      return empty;
    } finally {
      clearTimeout(timer);
    }
  };
}
