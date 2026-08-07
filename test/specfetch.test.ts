import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveSpec, type FetchResponse, type Fetcher } from '../src/specfetch.ts';

const OPENAPI = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Acme', version: '1' },
  paths: { '/v1/charges': { post: {} } },
});

const APIS_JSON = JSON.stringify({
  name: 'Acme',
  apis: [
    {
      name: 'Acme API',
      properties: [
        { type: 'Swagger', url: 'https://acme.com/spec/openapi.json' },
        { type: 'Documentation', url: 'https://acme.com/docs' },
      ],
    },
  ],
});

/** A fetcher over a fixed map, recording what was asked for. */
function fakeFetch(
  routes: Record<string, Partial<FetchResponse>>,
): Fetcher & { asked: string[] } {
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
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-spec-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Walking the sources
// ---------------------------------------------------------------------------

test('the provider’s own origin is tried first, and settles it', async () => {
  const s = scratch();
  try {
    const fetch = fakeFetch({ 'https://acme.com/openapi.json': { body: OPENAPI } });
    const found = await resolveSpec({ domain: 'acme.com' }, { fetch, cacheDir: s.dir });

    assert.equal(found[0]?.provenance, 'official-domain');
    // Nothing below the authority line was consulted: once the provider's own
    // word is in hand, a third party's copy cannot improve on it, and every
    // further request is latency and someone's rate limit for nothing.
    assert.ok(!fetch.asked.some((u) => u.includes('apis.guru')));
  } finally {
    s.cleanup();
  }
});

test('a provider-published manifest is followed to the spec it names', async () => {
  // APIs.json is the provider's own index of where its descriptions live, so
  // following it lands on first-party content — the reason the directory ranks
  // above the platforms that host copies.
  const s = scratch();
  try {
    const fetch = fakeFetch({
      'https://acme.com/apis.json': { body: APIS_JSON },
      'https://acme.com/spec/openapi.json': { body: OPENAPI },
    });
    const found = await resolveSpec({ domain: 'acme.com' }, { fetch, cacheDir: s.dir });

    assert.equal(found[0]?.provenance, 'official-domain');
    assert.equal(found[0]?.url, 'https://acme.com/spec/openapi.json');
  } finally {
    s.cleanup();
  }
});

test('a manifest pointing off-domain keeps the directory’s standing, not the provider’s', async () => {
  // Discovery source versus truth source. The manifest is the provider's, the
  // bytes are not, and only the second decides what may be claimed.
  const s = scratch();
  try {
    const fetch = fakeFetch({
      'https://acme.com/apis.json': {
        body: JSON.stringify({
          apis: [{ properties: [{ type: 'OpenAPI', url: 'https://cdn.elsewhere.net/acme.json' }] }],
        }),
      },
      'https://cdn.elsewhere.net/acme.json': { body: OPENAPI },
    });
    const found = await resolveSpec({ domain: 'acme.com' }, { fetch, cacheDir: s.dir });

    const hit = found.find((c) => c.url.includes('elsewhere'));
    assert.equal(hit?.provenance, 'directory');
  } finally {
    s.cleanup();
  }
});

test('nothing found means nothing returned, never a clean bill of health', async () => {
  // A detector that cannot find a spec has to say the spec was unavailable. It
  // must never report "no problem", which is what an empty result set silently
  // becomes if the caller is allowed to read it as "checked, and fine".
  const s = scratch();
  try {
    const found = await resolveSpec({ domain: 'acme.com' }, { fetch: fakeFetch({}), cacheDir: s.dir });
    assert.deepEqual(found, []);
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// What counts as a spec at all
// ---------------------------------------------------------------------------

test('an HTML error page served with 200 is not mistaken for a spec', async () => {
  // The common shape of a wrong guess: a well-known path that does not exist,
  // answered by a catch-all route with the marketing site and a 200. Accepting
  // it would mean diffing a web page against an API.
  const s = scratch();
  try {
    const fetch = fakeFetch({
      'https://acme.com/openapi.json': {
        body: '<!doctype html><html><body>Not found</body></html>',
        contentType: 'text/html',
      },
    });
    const found = await resolveSpec({ domain: 'acme.com' }, { fetch, cacheDir: s.dir });
    assert.deepEqual(found, []);
  } finally {
    s.cleanup();
  }
});

test('valid JSON that is not an API description is refused too', async () => {
  // Content type is a claim, not a check. A `{"error":"not found"}` body is
  // perfectly good JSON and describes no API at all.
  const s = scratch();
  try {
    const fetch = fakeFetch({
      'https://acme.com/openapi.json': { body: JSON.stringify({ error: 'not found' }) },
    });
    const found = await resolveSpec({ domain: 'acme.com' }, { fetch, cacheDir: s.dir });
    assert.deepEqual(found, []);
  } finally {
    s.cleanup();
  }
});

test('a swagger 2.0 description counts, because half the web still serves them', async () => {
  const s = scratch();
  try {
    const fetch = fakeFetch({
      'https://acme.com/swagger.json': {
        body: JSON.stringify({ swagger: '2.0', info: {}, paths: { '/v1/x': {} } }),
      },
    });
    const found = await resolveSpec({ domain: 'acme.com' }, { fetch, cacheDir: s.dir });
    assert.equal(found[0]?.provenance, 'official-domain');
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Where the bytes actually came from
// ---------------------------------------------------------------------------

test('a redirect off the provider’s domain downgrades what the result may claim', async () => {
  // The quiet way a first-party fetch stops being first-party. `acme.com` is
  // asked, a CDN answers, and the URL that was requested is no longer the URL
  // that was served. Provenance follows the bytes, so it is derived from the
  // final URL and never from the one we hoped for.
  const s = scratch();
  try {
    const fetch = fakeFetch({
      'https://acme.com/openapi.json': {
        body: OPENAPI,
        url: 'https://random-mirror.example.net/acme/openapi.json',
      },
    });
    const found = await resolveSpec({ domain: 'acme.com' }, { fetch, cacheDir: s.dir });

    assert.equal(found.length, 1);
    assert.notEqual(found[0]?.provenance, 'official-domain');
    assert.equal(found[0]?.url, 'https://random-mirror.example.net/acme/openapi.json');
  } finally {
    s.cleanup();
  }
});

test('a redirect within the provider’s own domain stays first-party', async () => {
  const s = scratch();
  try {
    const fetch = fakeFetch({
      'https://acme.com/openapi.json': { body: OPENAPI, url: 'https://api.acme.com/v2/openapi.json' },
    });
    const found = await resolveSpec({ domain: 'acme.com' }, { fetch, cacheDir: s.dir });
    assert.equal(found[0]?.provenance, 'official-domain');
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------

test('a second resolution reads the cache instead of the network', async () => {
  const s = scratch();
  try {
    const routes = { 'https://acme.com/openapi.json': { body: OPENAPI } };
    const first = fakeFetch(routes);
    await resolveSpec({ domain: 'acme.com' }, { fetch: first, cacheDir: s.dir });
    assert.ok(first.asked.length > 0);

    const second = fakeFetch(routes);
    const found = await resolveSpec({ domain: 'acme.com' }, { fetch: second, cacheDir: s.dir });
    assert.equal(second.asked.length, 0, 'nothing was asked the second time');
    assert.equal(found[0]?.provenance, 'official-domain');
    assert.ok(found[0]?.body?.includes('openapi'));
  } finally {
    s.cleanup();
  }
});

test('a stale cache entry is refetched rather than trusted', async () => {
  // The staleness signal a mirror gives is the only one there is, so it has to
  // mean something. An entry older than its lifetime is a lead, not an answer.
  const s = scratch();
  try {
    const routes = { 'https://acme.com/openapi.json': { body: OPENAPI } };
    await resolveSpec({ domain: 'acme.com' }, { fetch: fakeFetch(routes), cacheDir: s.dir });

    const again = fakeFetch(routes);
    await resolveSpec(
      { domain: 'acme.com' },
      { fetch: again, cacheDir: s.dir, maxAgeMs: 0 },
    );
    assert.ok(again.asked.length > 0, 'a zero lifetime means every entry is stale');
  } finally {
    s.cleanup();
  }
});

test('a failed fetch is not cached as an absence', async () => {
  // Caching "there is no spec" would make one bad afternoon on someone's CDN
  // into a lasting belief that an API has no description.
  const s = scratch();
  try {
    await resolveSpec({ domain: 'acme.com' }, { fetch: fakeFetch({}), cacheDir: s.dir });

    const later = fakeFetch({ 'https://acme.com/openapi.json': { body: OPENAPI } });
    const found = await resolveSpec({ domain: 'acme.com' }, { fetch: later, cacheDir: s.dir });
    assert.equal(found[0]?.provenance, 'official-domain');
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Aggregators
// ---------------------------------------------------------------------------

/** The shape the live per-domain endpoint returns, entries flattened under `apis`. */
function guruEntry(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    apis: {
      'acme.com': {
        swaggerUrl: 'https://api.apis.guru/v2/specs/acme.com/2022-11-15/openapi.json',
        info: {
          'x-origin': [{ format: 'openapi', url: 'https://raw.githubusercontent.com/acme/openapi/master/spec3.yaml' }],
        },
        ...over,
      },
    },
  });
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// apis.io
//
// The only directory now. Covered in detail in `apisio.test.ts`; what belongs
// here is how it interacts with the rest of the walk.
// ---------------------------------------------------------------------------

const APIS_IO = 'https://apis.io/api/v1';
const MANIFEST = 'https://raw.githubusercontent.com/curator/acme/main/apis.yml';

function directoryRoutes(): Record<string, Partial<FetchResponse>> {
  return {
    [`${APIS_IO}/providers/acme`]: {
      body: JSON.stringify({ slug: 'acme', image: 'https://acme.com/logo.png', url: MANIFEST }),
    },
    [MANIFEST]: {
      body: JSON.stringify({
        apis: [{ properties: [{ type: 'OpenAPI', url: 'https://cdn.curator.example/acme.json' }] }],
      }),
    },
    'https://cdn.curator.example/acme.json': { body: OPENAPI },
  };
}

test('a directory listing does not stop the walk reaching a first-party one', async () => {
  // Consulting the directory must not mean settling for it. Its listings are
  // never the provider's own word, so the walk carries on and the ranking puts a
  // first-party description in front. Ordering a source earlier should never
  // produce a worse answer than not having it.
  const s = scratch();
  try {
    const fetch = fakeFetch({ ...directoryRoutes(), 'https://acme.com/openapi.json': { body: OPENAPI } });
    const found = await resolveSpec({ domain: 'api.acme.com' }, { fetch, cacheDir: s.dir });
    assert.equal(found[0]?.provenance, 'official-domain');
  } finally {
    s.cleanup();
  }
});

test('a call-site host resolves against the registrable domain directories key on', async () => {
  // Found live, and it silenced the detector completely. Call sites hand us
  // `api.stripe.com` while a directory is keyed on `stripe.com`, so asking about
  // the host alone returned nothing. The host is what a repository actually
  // contains, so the resolver bridges that itself.
  const s = scratch();
  try {
    const fetch = fakeFetch(directoryRoutes());
    const found = await resolveSpec({ domain: 'api.acme.com' }, { fetch, cacheDir: s.dir });
    assert.equal(found[0]?.url, 'https://cdn.curator.example/acme.json');
    assert.equal(found[0]?.provenance, 'directory');
  } finally {
    s.cleanup();
  }
});

test('a description on the bare domain is found from a call site on a subdomain', async () => {
  const s = scratch();
  try {
    const fetch = fakeFetch({ 'https://acme.com/openapi.json': { body: OPENAPI } });
    const found = await resolveSpec({ domain: 'api.acme.com' }, { fetch, cacheDir: s.dir });
    assert.equal(found[0]?.provenance, 'official-domain');
  } finally {
    s.cleanup();
  }
});

test('the host itself is still tried first, since that is where the API lives', async () => {
  const s = scratch();
  try {
    const fetch = fakeFetch({
      'https://api.acme.com/openapi.json': { body: OPENAPI },
      'https://acme.com/openapi.json': { body: OPENAPI },
    });
    const found = await resolveSpec({ domain: 'api.acme.com' }, { fetch, cacheDir: s.dir });
    assert.equal(found[0]?.url, 'https://api.acme.com/openapi.json');
  } finally {
    s.cleanup();
  }
});

test('an org that was never supplied does not get credited for a GitHub URL', async () => {
  // Anyone may host a mirror on GitHub. Without being told the provider's org, a
  // pointer there is still the best route available and is still not first-party.
  const s = scratch();
  try {
    const fetch = fakeFetch({
      [`${APIS_IO}/providers/acme`]: {
        body: JSON.stringify({ slug: 'acme', image: 'https://acme.com/logo.png', url: MANIFEST }),
      },
      [MANIFEST]: {
        body: JSON.stringify({
          apis: [{ properties: [{ type: 'OpenAPI', url: 'https://raw.githubusercontent.com/acme/spec/main/x.json' }] }],
        }),
      },
      'https://raw.githubusercontent.com/acme/spec/main/x.json': { body: OPENAPI },
    });
    const found = await resolveSpec({ domain: 'api.acme.com' }, { fetch, cacheDir: s.dir });
    assert.equal(found[0]?.provenance, 'directory');
  } finally {
    s.cleanup();
  }
});

test('the framework defaults are tried, not just the hand-written ones', async () => {
  // Measured: guessing `/openapi.json` on an origin almost never lands. What
  // does land is whatever the framework generates by default — springfox's
  // `/v2/api-docs`, ASP.NET's `/swagger/v1/swagger.json` — because nobody moves
  // those. Conventions, not guesses; the list stays short for that reason.
  const s = scratch();
  try {
    const fetch = fakeFetch({
      'https://acme.com/swagger/v1/swagger.json': {
        body: JSON.stringify({ swagger: '2.0', info: {}, paths: { '/x': {} } }),
      },
    });
    const found = await resolveSpec({ domain: 'acme.com' }, { fetch, cacheDir: s.dir });
    assert.equal(found[0]?.provenance, 'official-domain');
  } finally {
    s.cleanup();
  }
});
