import test from 'node:test';
import assert from 'node:assert/strict';
import { claimsVendor, githubSpecUrls, lastChangedAt } from '../src/github.ts';
import type { FetchResponse, Fetcher } from '../src/specfetch.ts';

function fakeFetch(routes: Record<string, Partial<FetchResponse>>): Fetcher & { asked: string[] } {
  const asked: string[] = [];
  const f = async (url: string): Promise<FetchResponse> => {
    asked.push(url);
    const hit = routes[url];
    if (!hit) return { ok: false, status: 404, url, body: '', contentType: '' };
    return { ok: true, status: 200, url, body: hit.body ?? '', contentType: 'application/json', ...hit };
  };
  return Object.assign(f, { asked });
}

const API = 'https://api.github.com';

function routes(over: Record<string, Partial<FetchResponse>> = {}) {
  return {
    [`${API}/orgs/acme`]: { body: JSON.stringify({ login: 'acme', name: 'Acme', blog: 'https://acme.com' }) },
    [`${API}/orgs/acme/repos?per_page=100&sort=updated`]: {
      body: JSON.stringify([
        { name: 'website', default_branch: 'main' },
        { name: 'openapi', default_branch: 'master' },
        { name: 'acme-cli', default_branch: 'main' },
      ]),
    },
    [`${API}/repos/acme/openapi/git/trees/master?recursive=1`]: {
      body: JSON.stringify({
        tree: [
          { path: 'README.md', type: 'blob' },
          { path: 'openapi/spec3.json', type: 'blob' },
          { path: 'openapi/spec3.yaml', type: 'blob' },
          { path: 'src/index.ts', type: 'blob' },
        ],
      }),
    },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Attribution — the highest-stakes decision in the resolver
// ---------------------------------------------------------------------------

test('an org that claims the vendor’s domain is accepted', () => {
  // `blog` is the org's own statement about which site is theirs. It is the only
  // signal here that GitHub actually verifies nothing about — but it is the org
  // asserting it, not us guessing.
  return githubSpecUrls(fakeFetch(routes()), 'api.acme.com', {}).then((found) => {
    assert.equal(found.length, 2);
    assert.equal(found[0]?.org, 'acme');
    assert.ok(found[0]?.url.startsWith('https://raw.githubusercontent.com/acme/openapi/master/'));
  });
});

test('an org that claims nothing about the vendor is refused', async () => {
  // This tier is the one that may assert a call is broken. Everywhere else a
  // wrong attribution costs a bad lead; here it costs a confident, wrong claim
  // that somebody's integration is broken. So the bar is a link back, not a
  // resemblance.
  const found = await githubSpecUrls(
    fakeFetch(routes({ [`${API}/orgs/acme`]: { body: JSON.stringify({ login: 'acme', blog: 'https://unrelated.example' }) } })),
    'api.acme.com',
    {},
  );
  assert.deepEqual(found, []);
});

test('an org named by the operator is trusted without a link back', async () => {
  // Measured, and the reason this escape hatch exists: Stripe's GitHub org
  // records `stripe.dev` as its site, not `stripe.com`, so no automatic check
  // can connect the two. An operator who knows is allowed to say so.
  const found = await githubSpecUrls(
    fakeFetch({
      ...routes({ [`${API}/orgs/acme`]: { body: JSON.stringify({ login: 'acme', blog: 'https://acme.dev' }) } }),
    }),
    'api.acme.com',
    { org: 'acme' },
  );
  assert.equal(found.length, 2);
});

test('the conventional suffixes are tried, since the bare label rarely is the org', async () => {
  // Measured: `api.slack.com` derives `slack`, and Slack's descriptions live in
  // `slackapi`. Anthropic's live in `anthropics`. Deriving only the bare label
  // found neither, which made auto-discovery useless for most vendors.
  //
  // Safe to widen because the check did not move: each candidate still has to
  // claim the vendor's domain as its own, and `slackapi` records `slack.com`
  // exactly as `anthropics` records `anthropic.com`.
  const fetch = fakeFetch({
    [`${API}/orgs/acmeapi`]: { body: JSON.stringify({ login: 'acmeapi', blog: 'https://acme.com' }) },
    [`${API}/orgs/acmeapi/repos?per_page=100&sort=updated`]: {
      body: JSON.stringify([{ name: 'acme-openapi', default_branch: 'main' }]),
    },
    [`${API}/repos/acmeapi/acme-openapi/git/trees/main?recursive=1`]: {
      body: JSON.stringify({ tree: [{ path: 'openapi.json', type: 'blob' }] }),
    },
  });
  const found = await githubSpecUrls(fetch, 'api.acme.com', {});
  assert.equal(found[0]?.org, 'acmeapi');
});

test('a suffixed org that claims nothing is refused like any other', async () => {
  // Widening what is *tried* must not widen what is *believed*. `acmes` might be
  // anyone.
  const found = await githubSpecUrls(
    fakeFetch({
      [`${API}/orgs/acmes`]: { body: JSON.stringify({ login: 'acmes', blog: 'https://someone-else.example' }) },
      [`${API}/orgs/acmes/repos?per_page=100&sort=updated`]: {
        body: JSON.stringify([{ name: 'openapi', default_branch: 'main' }]),
      },
    }),
    'api.acme.com',
    {},
  );
  assert.deepEqual(found, []);
});

test('the bare label is tried first, because usually it is right', async () => {
  const fetch = fakeFetch(routes());
  await githubSpecUrls(fetch, 'api.acme.com', {});
  assert.equal(fetch.asked[0], `${API}/orgs/acme`);
});

test('a subdomain resolves against the registrable domain', async () => {
  const found = await githubSpecUrls(fakeFetch(routes()), 'api.acme.com', {});
  assert.ok(found.length > 0);
});

// ---------------------------------------------------------------------------
// Finding the file
// ---------------------------------------------------------------------------

test('only repositories that look like they hold a description are opened', async () => {
  // Measured: there is no naming convention — `stripe/openapi`,
  // `twilio/twilio-oai`, `github/rest-api-description`, `slackapi/slack-api-specs`.
  // What they share is a word, so the name is filtered and nothing else is read.
  const fetch = fakeFetch(routes());
  await githubSpecUrls(fetch, 'api.acme.com', {});
  assert.ok(fetch.asked.some((u) => u.includes('/repos/acme/openapi/git/trees/')));
  assert.ok(!fetch.asked.some((u) => u.includes('/repos/acme/website/')));
  assert.ok(!fetch.asked.some((u) => u.includes('/repos/acme/acme-cli/')));
});

test('the tree is read at the repository’s own default branch', async () => {
  // `master` here, `main` elsewhere. Guessing one costs a 404 and a wasted
  // request against a sixty-per-hour budget.
  const fetch = fakeFetch(routes());
  await githubSpecUrls(fetch, 'api.acme.com', {});
  assert.ok(fetch.asked.some((u) => u.endsWith('/git/trees/master?recursive=1')));
});

test('files that are not descriptions are left alone', async () => {
  const found = await githubSpecUrls(fakeFetch(routes()), 'api.acme.com', {});
  assert.ok(!found.some((f) => f.url.includes('README')));
  assert.ok(!found.some((f) => f.url.includes('index.ts')));
});

test('the most complete description wins, not the shortest filename', async () => {
  // Measured against Twilio, which publishes about thirty separate descriptions.
  // The shortest name won and picked `twilio_iam_v1.json` — a 0.1MB corner of the
  // API — over the description of everything else. A fragment matters more here
  // than anywhere else: this tier is authoritative, so it is trusted to say that
  // endpoints it never described are missing.
  const fetch = fakeFetch({
    ...routes(),
    [`${API}/repos/acme/openapi/git/trees/master?recursive=1`]: {
      body: JSON.stringify({
        tree: [
          { path: 'spec/json/acme_iam_v1.json', type: 'blob', size: 90_000 },
          { path: 'spec/json/acme_api_v2010.json', type: 'blob', size: 8_000_000 },
        ],
      }),
    },
  });
  const found = await githubSpecUrls(fetch, 'api.acme.com', {});
  assert.match(found[0]?.url ?? '', /acme_api_v2010\.json$/);
});

test('a plain name beats a qualified variant of it, even a larger one', async () => {
  // Measured against Stripe: `spec3.json` describes 589 operations and
  // `spec3.sdk.json` describes 536, while being half again as large. Ranking on
  // size alone chose the variant — which would have reported fifty-three live
  // endpoints as missing, from a description authoritative enough to be believed.
  const fetch = fakeFetch({
    ...routes(),
    [`${API}/repos/acme/openapi/git/trees/master?recursive=1`]: {
      body: JSON.stringify({
        tree: [
          { path: 'openapi/spec3.sdk.json', type: 'blob', size: 12_800_000 },
          { path: 'openapi/spec3.json', type: 'blob', size: 8_000_000 },
        ],
      }),
    },
  });
  const found = await githubSpecUrls(fetch, 'api.acme.com', {});
  assert.match(found[0]?.url ?? '', /spec3\.json$/);
});

test('a description is found by the directory it sits in, not only its name', async () => {
  // Measured: Twilio keeps `spec/json/twilio_api_v2010.json`, whose filename
  // contains no keyword at all. Matching names alone returned its linter config,
  // `spectral.yaml`, and pushed every real description out of the shortlist.
  const fetch = fakeFetch({
    ...routes(),
    [`${API}/repos/acme/openapi/git/trees/master?recursive=1`]: {
      body: JSON.stringify({
        tree: [
          { path: 'spectral.yaml', type: 'blob' },
          { path: 'package.json', type: 'blob' },
          { path: '.github/workflows/ci.yml', type: 'blob' },
          { path: 'spec/json/acme_api_v1.json', type: 'blob' },
        ],
      }),
    },
  });
  const found = await githubSpecUrls(fetch, 'api.acme.com', {});
  assert.deepEqual(
    found.map((f) => f.url.split('/master/')[1]),
    ['spec/json/acme_api_v1.json'],
  );
});

test('a token is sent when there is one, because sixty an hour is not a budget', async () => {
  // Unauthenticated GitHub allows 60 core requests an hour. A hosted scan across
  // many repositories exhausts that in minutes.
  const seen: Array<Record<string, string> | undefined> = [];
  const fetch: Fetcher = async (url, init) => {
    seen.push(init?.headers);
    const r = routes()[url as keyof ReturnType<typeof routes>];
    return r
      ? { ok: true, status: 200, url, body: r.body ?? '', contentType: 'application/json' }
      : { ok: false, status: 404, url, body: '', contentType: '' };
  };
  await githubSpecUrls(fetch, 'api.acme.com', { token: 'ghp_x' });
  assert.ok(seen.some((h) => h?.['authorization'] === 'Bearer ghp_x'));
});

test('being rate limited yields nothing rather than a wrong answer', async () => {
  const found = await githubSpecUrls(
    fakeFetch({ [`${API}/orgs/acme`]: { ok: false, status: 403, body: 'rate limit exceeded' } }),
    'api.acme.com',
    {},
  );
  assert.deepEqual(found, []);
});

// ---------------------------------------------------------------------------
// When the provider last touched the description
// ---------------------------------------------------------------------------

const COMMITS = `${API}/repos/slackapi/slack-api-specs/commits?path=web-api%2Fslack_web_openapi_v2.json&per_page=1`;

test('the date a description last changed is read from the commit that changed it', async () => {
  // Not the repository's newest commit: a README tidy in a dead repository
  // would make an abandoned description look maintained. `slackapi/slack-api-specs`
  // is exactly that shape — its last commit is 2021 documentation, while the
  // description itself has not moved since 2020.
  const at = await lastChangedAt(
    fakeFetch({ [COMMITS]: { body: JSON.stringify([{ commit: { committer: { date: '2020-10-06T00:00:00Z' } } }]) } }),
    'https://raw.githubusercontent.com/slackapi/slack-api-specs/master/web-api/slack_web_openapi_v2.json',
    {},
  );
  assert.equal(at, '2020-10-06T00:00:00Z');
});

test('a branch spelled refs/heads is the same branch', async () => {
  const url = `${API}/repos/acme/openapi/commits?path=openapi%2Fspec.json&per_page=1`;
  const at = await lastChangedAt(
    fakeFetch({ [url]: { body: JSON.stringify([{ commit: { committer: { date: '2026-08-01T00:00:00Z' } } }]) } }),
    'https://raw.githubusercontent.com/acme/openapi/refs/heads/main/openapi/spec.json',
    {},
  );
  assert.equal(at, '2026-08-01T00:00:00Z');
});

test('a date that cannot be established is undefined, never today', async () => {
  // Rate limited, or a URL that is not a repository file. Both mean "not
  // known", and `canAssertBreakage` treats not-known as not-current — which is
  // the whole point of asking.
  assert.equal(await lastChangedAt(fakeFetch({}), 'https://raw.githubusercontent.com/a/b/main/x.json', {}), undefined);
  assert.equal(await lastChangedAt(fakeFetch({}), 'https://api.acme.com/openapi.json', {}), undefined);
});

// ---------------------------------------------------------------------------
// Claiming the domain back
// ---------------------------------------------------------------------------

test('an organisation whose site is a sibling domain of the vendor still counts', () => {
  // The measured failure, and the reason Stripe — the worked example in the
  // brief this is meant to serve — resolved to a third-party mirror that may
  // assert nothing. Stripe's organisation records `stripe.dev` as its site, not
  // `stripe.com`, so demanding the blog sit *under* the vendor's domain rejected
  // the provider's own organisation. Publishing docs on a sibling domain is
  // ordinary; `vercel.com`/`vercel.app`, `stripe.com`/`stripe.dev`.
  //
  // The login already had to be derived from the vendor's own label, so this
  // asks for a second, independent claim on the same name rather than loosening
  // to nothing.
  assert.equal(claimsVendor('https://stripe.dev', 'stripe.com'), true);
  assert.equal(claimsVendor('https://stripe.com', 'stripe.com'), true);
  assert.equal(claimsVendor('https://docs.stripe.com', 'stripe.com'), true);
});

test('an organisation pointing somewhere unrelated does not count', () => {
  // The guard. Attribution here is the highest-stakes call the resolver makes:
  // everywhere else a wrong vendor costs a bad lead, here it costs a confident
  // claim that somebody's integration is broken.
  assert.equal(claimsVendor('https://example.com', 'stripe.com'), false);
  assert.equal(claimsVendor('https://stripe-fan-club.io', 'stripe.com'), false);
  assert.equal(claimsVendor('', 'stripe.com'), false);
  assert.equal(claimsVendor('not a url', 'stripe.com'), false);
});
