/**
 * Finding the description a provider publishes in their own repository.
 *
 * This is the source that produces `official-github`, and that makes it the
 * highest-stakes attribution in the resolver: everywhere else a wrong vendor
 * costs a bad lead, and here it costs a confident, wrong claim that somebody's
 * integration is broken. So an organisation is only credited when it says the
 * vendor's domain is its own, or when an operator has named it outright.
 *
 * There is no naming convention to exploit. Measured across real providers:
 * `stripe/openapi`, `twilio/twilio-oai`, `github/rest-api-description`,
 * `slackapi/slack-api-specs`. What they share is a word in the repository name,
 * which is enough to filter on and not enough to guess with — so the repository
 * list is read and filtered rather than constructed.
 */

import type { Fetcher } from './specfetch.ts';

const API = 'https://api.github.com';

/** Repositories worth opening. Every real one measured matches. */
const SPEC_REPO = /(openapi|swagger|oai|api-spec|api-specs|api-description|rest-api)/i;

/**
 * Ranking candidate files, rather than deciding which are descriptions.
 *
 * `looksLikeSpec` is the actual filter — it parses the body and checks for a
 * version key and a `paths` object — so this only has to bound how many files
 * are fetched and put the likely ones first. Being generous here is cheap;
 * being wrong is not, because a non-description is rejected on arrival.
 *
 * Measured layouts differ completely: Stripe keeps `openapi/spec3.json`, Twilio
 * keeps `spec/json/twilio_api_v2010.json` whose filename contains no keyword at
 * all, and Slack keeps `…slack_web_openapi_v2.json`. Matching on the filename
 * alone found Twilio's linter config, `spectral.yaml`, and nothing else.
 */
const SPEC_DIR = /(^|\/)(spec|specs|openapi|swagger|oai|descriptions|schemas)\//i;
const SPEC_NAME = /(openapi|swagger|spec\d)[^/]*\.(json|ya?ml)$/i;
const STRUCTURED = /\.(json|ya?ml)$/i;
/** Configuration and CI, which are structured files and never descriptions. */
const NOT_SPEC =
  /(^|\/)(\.github|\.circleci|node_modules|examples?|test|tests)\/|(^|\/)(package|package-lock|tsconfig|renovate|spectral)[^/]*\.(json|ya?ml)$/i;

function specScore(path: string): number {
  if (!STRUCTURED.test(path) || NOT_SPEC.test(path)) return -1;
  let score = 0;
  if (SPEC_DIR.test(path)) score += 3;
  if (SPEC_NAME.test(path)) score += 3;
  // Both forms are read, and JSON costs a tenth of what YAML does.
  if (/\.json$/i.test(path)) score += 1;
  // A plain name is the canonical artifact; a qualified one is a variant of it.
  // Measured: Stripe publishes `spec3.json` with 589 operations alongside
  // `spec3.sdk.json` with 536 — the variant is larger and describes less, so
  // ranking on size alone chose the one that would report fifty-three live
  // endpoints as missing.
  const basename = path.split('/').pop() ?? '';
  if (basename.split('.').length === 2) score += 2;
  return score;
}

/** Bounded, because the unauthenticated budget is sixty requests an hour. */
const MAX_REPOS = 3;
const MAX_FILES_PER_REPO = 3;

export interface GithubOptions {
  /** A personal access token. Sixty requests an hour is not a budget. */
  token?: string;
  /**
   * An organisation named by the operator, trusted without a link back.
   *
   * Measured, and the reason this exists: Stripe's GitHub organisation records
   * `stripe.dev` as its site rather than `stripe.com`, so no automatic check can
   * connect the two. Somebody who knows is allowed to say so.
   */
  org?: string;
}

/**
 * Organisation names worth trying for a vendor's label.
 *
 * Measured: `api.slack.com` derives `slack` and Slack's descriptions live in
 * `slackapi`; Anthropic's live in `anthropics`. The bare label alone found
 * neither, which made auto-discovery useless for most vendors.
 *
 * Widening what is *tried* is safe because it does not widen what is
 * *believed* — every candidate still has to claim the vendor's domain as its
 * own, and `slackapi` records `slack.com` exactly as `anthropics` records
 * `anthropic.com`. The bare label goes first because usually it is right.
 */
function orgCandidates(label: string): string[] {
  return [label, `${label}api`, `${label}s`, `${label}-api`, `${label}inc`];
}

export interface GithubSpecUrl {
  url: string;
  /** The organisation it came from, which is what makes it creditable. */
  org: string;
}

function registrable(host: string): string {
  const parts = host.toLowerCase().split('.');
  return parts.length <= 2 ? host.toLowerCase() : parts.slice(-2).join('.');
}

function isUnder(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Every description this provider publishes in their own repositories.
 *
 * Four requests for a typical vendor — the organisation, its repository list,
 * and a file tree for each repository that looks like it holds a description.
 * The repository list is one request for a hundred repositories, which is why it
 * is preferred to code search: search allows ten requests a minute.
 */
export async function githubSpecUrls(
  fetch: Fetcher,
  vendorDomain: string,
  options: GithubOptions,
): Promise<GithubSpecUrl[]> {
  const domain = registrable(vendorDomain);
  const label = domain.split('.')[0];
  if (!label) return [];

  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
  };
  const json = async (url: string): Promise<unknown | null> => {
    try {
      const res = await fetch(url, { headers });
      // A 403 here is a rate limit, and a rate limit is not an answer. Returning
      // nothing is right; returning a guess would be worse than being slow.
      if (!res.ok) return null;
      return JSON.parse(res.body);
    } catch {
      return null;
    }
  };

  // An organisation named by an operator is taken on their word. One discovered
  // from the domain has to claim the domain back.
  let org = options.org;
  if (!org) {
    for (const candidate of orgCandidates(label)) {
      const record = (await json(`${API}/orgs/${encodeURIComponent(candidate)}`)) as
        | { blog?: unknown }
        | null;
      if (!record) continue;
      const blog = typeof record.blog === 'string' ? record.blog : '';
      try {
        if (isUnder(new URL(blog).hostname.toLowerCase(), domain)) {
          org = candidate;
          break;
        }
      } catch {
        continue;
      }
    }
  }
  if (!org) return [];

  const repos = (await json(`${API}/orgs/${encodeURIComponent(org)}/repos?per_page=100&sort=updated`)) as
    | Array<{ name?: unknown; default_branch?: unknown }>
    | null;
  if (!Array.isArray(repos)) return [];

  const candidates = repos
    .filter((r) => typeof r.name === 'string' && SPEC_REPO.test(r.name))
    .slice(0, MAX_REPOS);

  const found: GithubSpecUrl[] = [];
  for (const repo of candidates) {
    const name = repo.name as string;
    // The repository's own default branch: `master` for Stripe, `main` for
    // others. Guessing costs a 404 out of a very small budget.
    const branch = typeof repo.default_branch === 'string' ? repo.default_branch : 'HEAD';
    const tree = (await json(
      `${API}/repos/${encodeURIComponent(org)}/${encodeURIComponent(name)}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    )) as { tree?: Array<{ path?: unknown; type?: unknown; size?: unknown }> } | null;
    if (!Array.isArray(tree?.tree)) continue;

    const files = tree.tree
      .filter((e) => e.type === 'blob' && typeof e.path === 'string')
      .map((e) => ({
        path: e.path as string,
        score: specScore(e.path as string),
        size: typeof e.size === 'number' ? e.size : 0,
      }))
      .filter((e) => e.score > 0)
      // Largest first among equals. Providers split their surface across many
      // files — Twilio publishes about thirty — and the shortest name won, which
      // picked `twilio_iam_v1.json`, a 0.1MB corner of the API, over the 8MB
      // description of the rest of it. A fragment at this tier is the dangerous
      // kind: it is authoritative enough to assert that endpoints it never
      // described are missing.
      .sort((a, b) => b.score - a.score || b.size - a.size)
      .slice(0, MAX_FILES_PER_REPO);
    for (const file of files) {
      found.push({
        org,
        url: `https://raw.githubusercontent.com/${org}/${name}/${branch}/${file.path}`,
      });
    }
  }
  return found;
}

/**
 * When the provider last changed the description at this URL.
 *
 * The signal `SpecCandidate.fetchedAt` was quietly standing in for and is not:
 * a copy pulled today out of a repository nobody has touched since 2020 was
 * indistinguishable from one the provider revised this morning, and Emend
 * asserted breakage from both. `slackapi/slack-api-specs` is the measured case
 * — five years untouched, still listing endpoints Slack has retired.
 *
 * Asked per *path* rather than per repository on purpose. A README tidy or a
 * licence bump makes a dead repository look alive, and Slack's is exactly that
 * shape: its newest commit is 2021 documentation while the description itself
 * stopped moving in 2020.
 *
 * `undefined` means *could not establish* — a rate limit, a URL that is not a
 * repository file, anything. It never guesses at a date, because the caller
 * reads an unknown date as "not current", and a wrong date here licences a
 * confident claim that somebody's integration is broken.
 */
export async function lastChangedAt(
  fetch: Fetcher,
  url: string,
  options: GithubOptions,
): Promise<string | undefined> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.hostname.toLowerCase() !== 'raw.githubusercontent.com') return undefined;

  const parts = parsed.pathname.split('/').filter(Boolean);
  const [owner, repo, ...rest] = parts;
  if (!owner || !repo || rest.length === 0) return undefined;
  // `/OWNER/REPO/BRANCH/PATH` and `/OWNER/REPO/refs/heads/BRANCH/PATH` both
  // occur in the wild; the ref is whatever sits between the repo and the file.
  const path = (rest[0] === 'refs' && rest[1] === 'heads' ? rest.slice(3) : rest.slice(1)).join('/');
  if (!path) return undefined;

  const endpoint = `${API}/repos/${owner}/${repo}/commits?path=${encodeURIComponent(path)}&per_page=1`;
  try {
    const res = await fetch(endpoint, {
      headers: {
        accept: 'application/vnd.github+json',
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
    });
    if (!res.ok) return undefined;
    const body: unknown = JSON.parse(res.body);
    if (!Array.isArray(body) || body.length === 0) return undefined;
    const date = (body[0] as { commit?: { committer?: { date?: unknown } } })?.commit?.committer?.date;
    return typeof date === 'string' ? date : undefined;
  } catch {
    return undefined;
  }
}
