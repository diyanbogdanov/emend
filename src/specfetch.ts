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
import YAML from 'yaml';
import { MAX_SPEC_BYTES, parseSpec } from './specdiff.ts';
import { githubSpecUrls, lastChangedAt, type GithubOptions } from './github.ts';
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

export interface FetchInit {
  /** Extra request headers — an API token, an accept type. */
  headers?: Record<string, string>;
  /** `GET` unless given. OSV screens a whole tree with one POST. */
  method?: string;
  body?: string;
}

/**
 * Injected rather than called directly, so the resolution order and the
 * acceptance rules are testable without a network.
 */
export type Fetcher = (url: string, init?: FetchInit) => Promise<FetchResponse>;

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
  /**
   * Look in the provider's own GitHub organisation.
   *
   * Opt-in, because it is the only source that can produce a description Emend
   * may assert breakage from, and because GitHub allows sixty unauthenticated
   * requests an hour — a budget a hosted scan exhausts in minutes.
   */
  github?: GithubOptions;
}

type Doc = Record<string, unknown>;

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Is this actually a description?
// ---------------------------------------------------------------------------

/**
 * Whether a body is an API description rather than something that merely
 * arrived with a 200.
 *
 * Structural, not by content type: a content type is a claim the server makes,
 * and `{"error":"not found"}` is perfectly good JSON describing no API at all.
 * Accepting or refusing is `parseSpec`'s decision, so what a fetch will take and
 * what the diff can read cannot drift apart.
 */
export function looksLikeSpec(body: string): boolean {
  return parseSpec(body) !== null;
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
  /**
   * Carried through the cache explicitly. It survives the round trip either way
   * — the entry is spread whole — but a type that omits it says a cached
   * candidate has no currency, and a candidate with no currency asserts
   * nothing. Leaving it implicit means one narrowing away from a cache that
   * silently disarms every finding it serves.
   */
  updatedAt?: string;
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
  /** An organisation established by the source that produced this URL. */
  org?: string,
  github?: GithubOptions,
): Promise<SpecCandidate | null> {
  let res: FetchResponse;
  try {
    res = await fetch(url);
  } catch {
    return null;
  }
  if (!res.ok || !looksLikeSpec(res.body)) return null;

  // Against the registrable domain, so a description for `api.stripe.com`
  // served from `stripe.com` is still the provider's own file.
  const provenance =
    floor ?? provenanceOfPointer(res.url, registrableDomain(vendor.domain), org ?? vendor.org);

  // A file in a repository keeps resolving long after anyone stopped
  // maintaining it, so it has to say when it last changed before it may assert
  // anything. Asked only for the provenance where the answer can change a
  // claim: a description served from the provider's own origin is current by
  // being served, and a third-party copy asserts nothing whatever its date.
  const updatedAt =
    provenance === 'official-github' ? await lastChangedAt(fetch, res.url, github ?? {}) : undefined;

  return {
    vendor: vendor.domain,
    // The URL that served it, not the one that was asked for.
    url: res.url,
    provenance,
    fetchedAt: now,
    ...(updatedAt ? { updatedAt } : {}),
    body: res.body,
  };
}

const APIS_IO = 'https://apis.io/api/v1';

/** Stripe publishes 159 APIs there; the listing fallback follows only a few. */
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

/** Anything the directory knows about a vendor: descriptions, docs, and the rest. */
export interface VendorArtifact {
  /** `OpenAPI`, `Documentation`, `Changelog`, `GraphQL`, `AsyncAPI`, `MCPServer`… */
  type: string;
  url: string;
  /** Whether it lives on the vendor's own domain rather than a curator's. */
  firstParty: boolean;
}

/**
 * Everything apis.io indexes for this vendor, from its provider manifest.
 *
 * The manifest rather than the per-API endpoints, because it is one request for
 * all of it: Anthropic's is 43KB and carries all twenty-four of its APIs with
 * every artifact type, where walking `/apis/{aid}` cost a request each and
 * returned strictly less.
 *
 * The directory is keyed by a slug — `stripe` — while every call site hands us a
 * host, and its records carry no domain field to bridge that. So the slug is
 * derived from the domain and then **verified**, by requiring the provider
 * record to link back to the vendor's own domain. No link, no attribution and no
 * further requests: `stripe` is a plausible slug for a dozen things, and
 * attribution by guess is how one company's API is reported as another's.
 */
export async function apisIoArtifacts(fetch: Fetcher, domain: string): Promise<VendorArtifact[]> {
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
  if (!provider) return [];
  // Verification is deferred until the artifacts are in hand, because neither
  // signal alone is enough. Measured across four vendors: Stripe's record links
  // home through its logo and its listings carry no `humanURL`, while Anthropic,
  // Linear and Supabase are the exact reverse. Requiring only the record
  // rejected three of the four.
  let confirmed = linksBackTo(provider, registrable);

  const collected: VendorArtifact[] = [];
  const seen = new Set<string>();
  const take = (type: unknown, url: unknown, base: string): void => {
    if (typeof type !== 'string' || typeof url !== 'string') return;
    let absolute: string;
    let host: string;
    try {
      // Artifact URLs in a manifest are relative to it —
      // `openapi/acme-openapi.yml` — so taking them verbatim yields nothing
      // fetchable and the directory silently contributes zero.
      const resolved = new URL(url, base);
      absolute = resolved.toString();
      host = resolved.hostname.toLowerCase();
    } catch {
      return;
    }
    if (seen.has(absolute)) return;
    seen.add(absolute);
    const firstParty = host === registrable || host.endsWith(`.${registrable}`);
    // An artifact on the vendor's own domain confirms this listing is theirs,
    // and is better evidence than a logo URL.
    if (firstParty) confirmed = true;
    collected.push({ type, url: absolute, firstParty });
  };

  // The manifest first: one request for every API and every artifact type.
  // Anthropic's is 43KB and carries all twenty-four of its APIs.
  const manifestUrl = provider['url'];
  if (typeof manifestUrl === 'string') {
    let res: FetchResponse | null = null;
    try {
      res = await fetch(manifestUrl);
    } catch {
      res = null;
    }
    if (res?.ok) {
      let doc: unknown;
      try {
        // APIs.json, served as JSON or YAML depending on the curator.
        doc = res.body.trimStart().startsWith('{')
          ? JSON.parse(res.body)
          : YAML.parse(res.body, { logLevel: 'silent' });
      } catch {
        doc = null;
      }
      const apis = (doc as { apis?: unknown } | null)?.apis;
      if (Array.isArray(apis)) {
        for (const api of apis) {
          const props = (api as { properties?: unknown })?.properties;
          if (!Array.isArray(props)) continue;
          for (const prop of props) {
            take((prop as Doc)['type'], (prop as Doc)['url'], res.url || manifestUrl);
          }
        }
      }
    }
  }
  if (collected.length > 0) return confirmed ? collected : [];

  // The manifest is not dependable. Measured: Stripe's `url` names an `apis.md`
  // that answers 404 while Anthropic's names a working `apis.yml`, so half the
  // directory's providers would otherwise resolve to nothing, silently. The
  // listing endpoints cost a request per API and always answer.
  const listing = await json(`${APIS_IO}/providers/${encodeURIComponent(slug)}/apis`);
  const data = listing?.['data'];
  if (!Array.isArray(data)) return [];

  for (const entry of data.slice(0, MAX_LISTINGS)) {
    const aid = (entry as Doc | undefined)?.['aid'];
    if (typeof aid !== 'string') continue;
    // `humanURL` is on the listing rather than in `properties`, and for the
    // newer vendors it is the only thing pointing at the provider at all.
    take('Documentation', (entry as Doc)['humanURL'], `${APIS_IO}/`);
    // The colon stays literal: `stripe:stripe-account-api` answers 200 and
    // `stripe%3Astripe-account-api` answers 404, so encoding it made every
    // lookup fail while still spending the requests.
    const detail = await json(`${APIS_IO}/apis/${encodeURIComponent(aid).replace(/%3A/gi, ':')}`);
    const props = detail?.['properties'];
    if (!Array.isArray(props)) continue;
    for (const prop of props) take((prop as Doc)['type'], (prop as Doc)['url'], `${APIS_IO}/`);
  }
  // No link back to the vendor from anywhere: the slug was derived, nothing
  // confirmed it, and attribution by guess is how one company's API is reported
  // as another's.
  return confirmed ? collected : [];
}

/**
 * Find every description of this vendor's API that can be located, best first.
 *
 * Sources are consulted from the provider's own origin outward — well-known
 * paths, then its `apis.json`, then its GitHub organisation, then the apis.io
 * directory — and the walk stops as soon as the provider's own word is in hand:
 * no third party's copy can improve on it, so every further request is latency
 * and somebody's rate limit spent for nothing.
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
  // the registrable domain. Asking a directory about the host returned nothing
  // and Stripe resolved to zero candidates, while asking about `stripe.com` had
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
      add(await candidateFrom(options.fetch, url, vendor, now, undefined, undefined, options.github));
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
      add(await candidateFrom(options.fetch, url, vendor, now, undefined, undefined, options.github));
      if (settled()) break;
    }
  }

  // 3. The provider's own GitHub organisation. Between their origin and the
  //    directory, because it is first-party — and the only source that can yield
  //    a description Emend may assert breakage from.
  if (!settled() && options.github) {
    for (const hit of await githubSpecUrls(options.fetch, vendor.domain, options.github)) {
      add(await candidateFrom(options.fetch, hit.url, vendor, now, undefined, hit.org, options.github));
      if (settled() || found.some((c) => c.provenance === 'official-github')) break;
    }
  }

  // 4. apis.io. The only directory left: apis.guru's weekly refresh stopped
  //    running in March while its README still advertises one, and a source
  //    claiming to be current when it is not is worse than no source at all —
  //    it makes a stale description look like a checked one.
  //
  //    Nothing from here is the provider's own word, so it cannot settle the
  //    walk and `canAssertBreakage` refuses it. It is a lead, and for anything
  //    published after about 2022 it is the only lead there is.
  if (!settled()) {
    for (const artifact of await apisIoArtifacts(options.fetch, vendor.domain)) {
      if (!/^(openapi|swagger)$/i.test(artifact.type)) continue;
      add(await candidateFrom(options.fetch, artifact.url, vendor, now, undefined, undefined, options.github));
      if (settled()) break;
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
  return async (url: string, init?: FetchInit): Promise<FetchResponse> => {
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
        ...(init?.method ? { method: init.method } : {}),
        ...(init?.body === undefined ? {} : { body: init.body }),
        headers: {
          accept: 'application/json, application/yaml, text/yaml, */*',
          ...init?.headers,
        },
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

/**
 * Everything known about a vendor beyond its description.
 *
 * A changelog and a documentation page are where an upgrade is *explained*, and
 * neither is expressible in a spec diff. Measured on the live directory: 59 of
 * Anthropic's 127 documentation entries are on `docs.anthropic.com` — the
 * provider's own words about their own API, which is worth more than any third
 * party's copy of them.
 */
export async function resolveArtifacts(
  vendor: Vendor,
  options: { fetch: Fetcher },
): Promise<VendorArtifact[]> {
  return apisIoArtifacts(options.fetch, vendor.domain);
}
