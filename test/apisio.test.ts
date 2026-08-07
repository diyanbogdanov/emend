import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveArtifacts, resolveSpec, type FetchResponse, type Fetcher } from '../src/specfetch.ts';

const OPENAPI = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Acme', version: '1' },
  paths: { '/v1/charges': { post: {} } },
});

function fakeFetch(routes: Record<string, Partial<FetchResponse>>): Fetcher & { asked: string[] } {
  const asked: string[] = [];
  const f = async (url: string): Promise<FetchResponse> => {
    asked.push(url);
    const hit = routes[url];
    if (!hit) return { ok: false, status: 404, url, body: '', contentType: '' };
    return {
      ok: true,
      status: 200,
      url: hit.url ?? url,
      body: hit.body ?? '',
      contentType: hit.contentType ?? 'application/json',
      ...hit,
    };
  };
  return Object.assign(f, { asked });
}

function scratch(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-io-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const MANIFEST_BASE = 'https://raw.githubusercontent.com/curator/acme/refs/heads/main/';
const MANIFEST_URL = `${MANIFEST_BASE}apis.yml`;

/** The real shape: relative artifact URLs, mixed types, some first-party. */
const MANIFEST = `name: Acme
apis:
  - name: Acme Charges API
    properties:
      - type: OpenAPI
        url: openapi/acme-charges-openapi.yml
      - type: Documentation
        url: https://docs.acme.com/en/api/charges
      - type: GraphQL
        url: graphql/acme-graphql.md
  - name: Acme Events API
    properties:
      - type: AsyncAPI
        url: asyncapi/acme-events.yml
      - type: MCPServer
        url: https://acme.com/mcp
      - type: Changelog
        url: https://acme.com/changelog
`;

function routes(over: Record<string, Partial<FetchResponse>> = {}) {
  return {
    'https://apis.io/api/v1/providers/acme': {
      body: JSON.stringify({ slug: 'acme', name: 'Acme', image: 'https://acme.com/logo.png', url: MANIFEST_URL }),
    },
    [MANIFEST_URL]: { body: MANIFEST, contentType: 'text/yaml' },
    [`${MANIFEST_BASE}openapi/acme-charges-openapi.yml`]: { body: OPENAPI },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The manifest, not the per-API endpoints
// ---------------------------------------------------------------------------

test('the provider manifest is read once instead of one call per listed API', async () => {
  // Measured on the live directory: Anthropic's manifest is 43KB and carries all
  // twenty-four of its APIs with every artifact type. Walking the per-API detail
  // endpoints instead cost one request each and returned strictly less.
  const s = scratch();
  try {
    const fetch = fakeFetch(routes());
    await resolveSpec({ domain: 'api.acme.com' }, { fetch, cacheDir: s.dir });
    assert.ok(fetch.asked.includes(MANIFEST_URL));
    assert.ok(
      !fetch.asked.some((u) => u.includes('/api/v1/apis/')),
      'no per-API detail calls were needed',
    );
  } finally {
    s.cleanup();
  }
});

test('a relative artifact URL is resolved against the manifest it came from', async () => {
  // The detail this turns on. Artifact URLs in the manifest are relative —
  // `openapi/acme-charges-openapi.yml` — so taking them verbatim yields nothing
  // fetchable and the directory silently contributes zero.
  const s = scratch();
  try {
    const fetch = fakeFetch(routes());
    const found = await resolveSpec({ domain: 'api.acme.com' }, { fetch, cacheDir: s.dir });
    assert.equal(found[0]?.url, `${MANIFEST_BASE}openapi/acme-charges-openapi.yml`);
    assert.equal(found[0]?.provenance, 'directory');
  } finally {
    s.cleanup();
  }
});

test('a provider is confirmed by its artifacts when its own record says nothing', async () => {
  // Measured across four vendors, and neither signal alone is enough. Stripe's
  // record links home through its logo and its listings carry no `humanURL`;
  // Anthropic, Linear and Supabase are the exact reverse — nothing on the record
  // points at the vendor, while every listing names `docs.anthropic.com`,
  // `linear.app/developers` or `supabase.com/docs`.
  //
  // Requiring only the record rejected three of the four, which is the whole
  // reason the directory was worth keeping. A documentation URL on the vendor's
  // own domain is better evidence than a logo anyway.
  const artifacts = await resolveArtifacts(
    { domain: 'api.acme.com' },
    {
      fetch: fakeFetch({
        'https://apis.io/api/v1/providers/acme': {
          body: JSON.stringify({ slug: 'acme', image: 'https://cdn.curator.example/logo.png' }),
        },
        'https://apis.io/api/v1/providers/acme/apis': {
          body: JSON.stringify({
            data: [{ aid: 'acme:acme-charges-api', humanURL: 'https://docs.acme.com/api/charges' }],
          }),
        },
        'https://apis.io/api/v1/apis/acme:acme-charges-api': {
          body: JSON.stringify({
            properties: [{ type: 'OpenAPI', url: 'https://cdn.curator.example/acme.json' }],
          }),
        },
      }),
    },
  );
  assert.ok(artifacts.length > 0, 'the vendor was confirmed by its documentation URL');
  assert.ok(artifacts.some((a) => a.url === 'https://docs.acme.com/api/charges' && a.firstParty));
});

test('nothing linking back to the vendor means nothing is attributed to it', async () => {
  // `acme` is a plausible slug for a dozen companies, and the slug is derived
  // rather than given. So a listing that is entirely a curator's — no artifact
  // on the vendor's domain, no logo, no documentation URL — is refused outright
  // rather than reported as this customer's API.
  //
  // Deliberately a listing with real, fetchable artifacts: rejecting an empty
  // one proves nothing, since there was nothing to reject.
  const unrelated = {
    'https://apis.io/api/v1/providers/acme': {
      body: JSON.stringify({ slug: 'acme', name: 'Unrelated', image: 'https://other.example/x.png', url: MANIFEST_URL }),
    },
    [MANIFEST_URL]: {
      body: JSON.stringify({
        apis: [
          {
            properties: [
              { type: 'OpenAPI', url: 'https://cdn.curator.example/unrelated.json' },
              { type: 'Documentation', url: 'https://cdn.curator.example/docs' },
            ],
          },
        ],
      }),
    },
    'https://cdn.curator.example/unrelated.json': { body: OPENAPI },
  };

  assert.deepEqual(
    await resolveArtifacts({ domain: 'api.acme.com' }, { fetch: fakeFetch(unrelated) }),
    [],
    'artifacts were found and then refused, rather than never found',
  );

  const s = scratch();
  try {
    const found = await resolveSpec({ domain: 'api.acme.com' }, { fetch: fakeFetch(unrelated), cacheDir: s.dir });
    assert.deepEqual(found, []);
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Everything else the directory knows
// ---------------------------------------------------------------------------

test('docs, changelog, GraphQL, AsyncAPI and MCP are collected, not just OpenAPI', async () => {
  // The directory indexes far more than descriptions, and the rest is what makes
  // it worth keeping: a changelog and a docs page are where an upgrade is
  // explained, and neither is expressible in a spec diff.
  const artifacts = await resolveArtifacts({ domain: 'api.acme.com' }, { fetch: fakeFetch(routes()) });
  const byType = Object.fromEntries(artifacts.map((a) => [a.type, a.url]));

  assert.equal(byType['Documentation'], 'https://docs.acme.com/en/api/charges');
  assert.equal(byType['Changelog'], 'https://acme.com/changelog');
  assert.equal(byType['MCPServer'], 'https://acme.com/mcp');
  assert.equal(byType['AsyncAPI'], `${MANIFEST_BASE}asyncapi/acme-events.yml`);
  assert.equal(byType['GraphQL'], `${MANIFEST_BASE}graphql/acme-graphql.md`);
});

test('an artifact on the vendor’s own domain is marked as theirs', async () => {
  // The same discovery-versus-truth rule, applied to everything rather than only
  // to descriptions. Measured live: 59 of Anthropic's 127 documentation entries
  // are on docs.anthropic.com, and those are the provider's own words about
  // their own API — worth far more than a third party's copy of them.
  const artifacts = await resolveArtifacts({ domain: 'api.acme.com' }, { fetch: fakeFetch(routes()) });
  const docs = artifacts.find((a) => a.type === 'Documentation');
  const graphql = artifacts.find((a) => a.type === 'GraphQL');

  assert.equal(docs?.firstParty, true, 'docs.acme.com is under acme.com');
  assert.equal(graphql?.firstParty, false, 'the curator’s repository is not');
});

test('nothing found yields nothing, and never an assertion of emptiness', async () => {
  const artifacts = await resolveArtifacts({ domain: 'api.acme.com' }, { fetch: fakeFetch({}) });
  assert.deepEqual(artifacts, []);
});

// ---------------------------------------------------------------------------
// The manifest is not always there
// ---------------------------------------------------------------------------

const LISTING_ROUTES = {
  'https://apis.io/api/v1/providers/acme': {
    // Measured: Stripe's `url` names an `apis.md` that 404s, while Anthropic's
    // names a working `apis.yml`. The field is not dependable.
    body: JSON.stringify({ slug: 'acme', image: 'https://acme.com/logo.png', url: `${MANIFEST_BASE}apis.md` }),
  },
  'https://apis.io/api/v1/providers/acme/apis': {
    body: JSON.stringify({ data: [{ aid: 'acme:acme-charges-api' }] }),
  },
  'https://apis.io/api/v1/apis/acme:acme-charges-api': {
    body: JSON.stringify({
      properties: [
        { type: 'OpenAPI', url: 'https://cdn.listing.example/acme-charges.json' },
        { type: 'Documentation', url: 'https://docs.acme.com/charges' },
      ],
    }),
  },
  'https://cdn.listing.example/acme-charges.json': { body: OPENAPI },
};

test('a provider whose manifest is missing falls back to the listing endpoints', async () => {
  // Half the directory's providers would otherwise resolve to nothing, silently.
  const artifacts = await resolveArtifacts({ domain: 'api.acme.com' }, { fetch: fakeFetch(LISTING_ROUTES) });
  const byType = Object.fromEntries(artifacts.map((a) => [a.type, a.url]));
  assert.equal(byType['OpenAPI'], 'https://cdn.listing.example/acme-charges.json');
  assert.equal(byType['Documentation'], 'https://docs.acme.com/charges');
});

test('the fallback still finds a usable description', async () => {
  const s = scratch();
  try {
    const found = await resolveSpec(
      { domain: 'api.acme.com' },
      { fetch: fakeFetch(LISTING_ROUTES), cacheDir: s.dir },
    );
    assert.equal(found[0]?.provenance, 'directory');
  } finally {
    s.cleanup();
  }
});

test('an api id keeps its colon, which is the only form the directory answers', async () => {
  // `stripe:stripe-account-api` answers 200 and `stripe%3A…` answers 404, so
  // encoding it made every listing lookup fail while still spending the requests.
  const fetch = fakeFetch(LISTING_ROUTES);
  await resolveArtifacts({ domain: 'api.acme.com' }, { fetch });
  assert.ok(fetch.asked.includes('https://apis.io/api/v1/apis/acme:acme-charges-api'));
});

test('the manifest is preferred when it works, so the fallback costs nothing', async () => {
  const fetch = fakeFetch(routes());
  await resolveArtifacts({ domain: 'api.acme.com' }, { fetch });
  assert.ok(!fetch.asked.some((u) => u.includes('/providers/acme/apis')));
});

// ---------------------------------------------------------------------------
// apis.guru is gone
// ---------------------------------------------------------------------------

test('no request is made to apis.guru, which stopped being maintained', async () => {
  // Its weekly refresh has not run since March, and its README still advertises
  // one. A source that says it is current and is not is worse than no source: it
  // makes a stale description look like a checked one.
  const s = scratch();
  try {
    const fetch = fakeFetch(routes());
    await resolveSpec({ domain: 'api.acme.com' }, { fetch, cacheDir: s.dir });
    assert.ok(!fetch.asked.some((u) => u.includes('apis.guru')));
  } finally {
    s.cleanup();
  }
});
