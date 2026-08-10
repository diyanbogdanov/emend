import test from 'node:test';
import assert from 'node:assert/strict';
import {
  exportedUrlConstants,
  findHttpCalls,
  matchAgainstDiff,
  mergeExportedConstants,
} from '../src/httpsites.ts';
import type { SurfaceChange } from '../src/types.ts';

function find(source: string) {
  return findHttpCalls('src/pay.ts', source);
}

// ---------------------------------------------------------------------------
// Finding the calls — high confidence, static and local
// ---------------------------------------------------------------------------

test('a fetch with a literal URL is found, with its method and route', () => {
  const calls = find(`
    await fetch('https://api.stripe.com/v1/charges', { method: 'POST' });
  `);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.host, 'api.stripe.com');
  assert.equal(calls[0]?.route, '/v1/charges');
  assert.equal(calls[0]?.method, 'POST');
  assert.equal(calls[0]?.resolved, true);
});

test('a fetch with no method is a GET, which is what fetch actually does', () => {
  const calls = find(`await fetch('https://api.stripe.com/v1/charges');`);
  assert.equal(calls[0]?.method, 'GET');
});

test('axios verb helpers are found, and carry their own method', () => {
  const calls = find(`
    axios.post('https://api.stripe.com/v1/charges', body);
    axios.get('https://api.stripe.com/v1/balance');
  `);
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.route}`).sort(),
    ['GET /v1/balance', 'POST /v1/charges'],
  );
});

test('got and node http clients are found too', () => {
  const calls = find(`
    got.put('https://api.stripe.com/v1/customers/x');
    ky.delete('https://api.stripe.com/v1/coupons/y');
  `);
  assert.deepEqual(
    calls.map((c) => c.method).sort(),
    ['DELETE', 'PUT'],
  );
});

test('a query string is not part of the route', () => {
  // `/v1/charges?limit=3` is the same endpoint as `/v1/charges`, and treating it
  // as a different one means never matching the description.
  const calls = find(`await fetch('https://api.stripe.com/v1/charges?limit=3');`);
  assert.equal(calls[0]?.route, '/v1/charges');
});

// ---------------------------------------------------------------------------
// Not being able to tell — medium confidence, and said out loud
// ---------------------------------------------------------------------------

test('a URL built from a variable is recorded as unresolved, never dropped', () => {
  // The honesty rule this whole detector turns on. A call whose URL cannot be
  // read statically is still a call to somewhere, and quietly skipping it is how
  // a report of "no problems" gets built out of things nobody looked at.
  const calls = find(`
    const url = base + '/v1/charges';
    await fetch(url, { method: 'POST' });
  `);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.resolved, false);
  assert.equal(calls[0]?.host, null);
  assert.match(calls[0]?.reason ?? '', /not a literal/i);
});

test('a template literal with a substituted path segment resolves what it can', () => {
  // `/v1/charges/${id}` is a real endpoint with a real parameter, and OpenAPI
  // spells it `/v1/charges/{id}`. Refusing to read it would lose most of the
  // interesting call sites in any codebase.
  const calls = find('await fetch(`https://api.stripe.com/v1/charges/${id}`);');
  assert.equal(calls[0]?.resolved, true);
  assert.equal(calls[0]?.route, '/v1/charges/{}');
});

test('a template literal whose host is substituted is unresolved', () => {
  // The host is what decides which API this is. Without it there is nothing to
  // check the call against.
  const calls = find('await fetch(`${base}/v1/charges`);');
  assert.equal(calls[0]?.resolved, false);
});

test('a host substituted after the scheme is unresolved, not a host named for the placeholder', () => {
  // `https://${domain}/x` writes the scheme literally, so it clears the
  // starts-with-a-substitution guard and reaches the parser. Measured across
  // eight repositories, this is the shape that leaked: the placeholder survived
  // into `hostname`, the call was recorded as resolved, and a runtime-decided
  // host was reported as one Emend had read. Unreadable must stay unreadable.
  const calls = find('await fetch(`https://${domain}/open-apis/im/v1/messages`);');
  assert.equal(calls[0]?.resolved, false);
  assert.match(calls[0]?.reason ?? '', /host is substituted/i);
});

test('a host only partly substituted is unresolved too', () => {
  // `sts.${region}.amazonaws.com` names a different endpoint per region, and
  // which one is a runtime fact. A partial read is not a read.
  const calls = find('await fetch(`https://sts.${region}.amazonaws.com/`, { method: "POST" });');
  assert.equal(calls[0]?.resolved, false);
});

test('a relative URL is unresolved rather than guessed at', () => {
  // Same-origin calls go to the application's own server, whose description
  // Emend was never given. Assuming a vendor would invent a finding.
  const calls = find(`await fetch('/api/internal/thing');`);
  assert.equal(calls[0]?.resolved, false);
  assert.match(calls[0]?.reason ?? '', /relative/i);
});

test('something that is not an HTTP call is not one', () => {
  const calls = find(`
    const x = prefetch('https://api.stripe.com/v1/charges');
    element.fetchPriority = 'high';
  `);
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// The contract check
// ---------------------------------------------------------------------------

function change(path: string, kind: SurfaceChange['kind'], severity: SurfaceChange['severity']): SurfaceChange {
  return { path, kind, severity, confidence: 'high', before: 'a', after: 'b' };
}

const CALLS = findHttpCalls(
  'src/pay.ts',
  `
    await fetch('https://api.stripe.com/v1/charges', { method: 'POST' });
    await fetch('https://api.stripe.com/v1/balance');
    await fetch(someUrl);
  `,
);

test('a change is reported only where a call actually reaches it', () => {
  const hits = matchAgainstDiff(CALLS, 'api.stripe.com', [
    change('POST /v1/charges', 'removed', 'breaking'),
    change('DELETE /v1/coupons', 'removed', 'breaking'),
  ]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.change.path, 'POST /v1/charges');
  assert.equal(hits[0]?.sites[0]?.line, 2);
});

test('a call to a different host is not matched against this vendor’s changes', () => {
  assert.deepEqual(matchAgainstDiff(CALLS, 'api.twilio.com', [change('POST /v1/charges', 'removed', 'breaking')]), []);
});

test('a new capability on an endpoint somebody calls is reported, and marked as one', () => {
  // This used to return nothing, on the reasoning that a new optional parameter
  // is not a task and raising it would bury seven real breaks under a hundred
  // and eighty-three additions. The burying is real; the silence was the wrong
  // cure. Whether to lead with something is a reporting decision, and it was
  // being made here, where the only question is whether a change reaches code.
  //
  // It also threw away the more common half of the work. A provider ships far
  // more capability than it removes, and "this endpoint you already call now
  // supports X" is the same job as "this endpoint is gone" — find the call
  // sites, offer the edit — with a much larger supply of it.
  const hits = matchAgainstDiff(CALLS, 'api.stripe.com', [change('POST /v1/charges', 'added', 'feature')]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.change.severity, 'feature', 'the caller can still lead with breaks');
  assert.equal(hits[0]?.sites[0]?.line, 2);
});

test('a change reaching no call site is still not reported', () => {
  // The filter that does belong here: this one is about whether the code is
  // touched at all, which is the question this function exists to answer.
  assert.deepEqual(
    matchAgainstDiff(CALLS, 'api.stripe.com', [change('POST /v1/coupons', 'added', 'feature')]),
    [],
  );
});

test('a parameter-level change is matched to its endpoint’s call sites', () => {
  const hits = matchAgainstDiff(CALLS, 'api.stripe.com', [
    change('POST /v1/charges query:idempotency_key', 'signature-changed', 'breaking'),
  ]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.sites.length, 1);
});

test('an OpenAPI path parameter matches the call that substitutes it', () => {
  const calls = findHttpCalls('src/pay.ts', 'await fetch(`https://api.stripe.com/v1/charges/${id}`);');
  const hits = matchAgainstDiff(calls, 'api.stripe.com', [
    change('GET /v1/charges/{charge}', 'removed', 'breaking'),
  ]);
  assert.equal(hits.length, 1, 'a substituted segment matches a templated one');
});

test('unresolved calls are carried alongside, not counted as clean', () => {
  // They are the reason a report may never say "no problems with your Stripe
  // integration". Emend looked at what it could read and says so.
  const hits = matchAgainstDiff(CALLS, 'api.stripe.com', [change('POST /v1/charges', 'removed', 'breaking')]);
  assert.equal(hits[0]?.unresolvedCalls, 1);
});

// ---------------------------------------------------------------------------
// Reading a base URL the file declares
// ---------------------------------------------------------------------------

test('a base URL held in a constant is read, because the file says what it is', () => {
  // The single biggest readable-but-unread shape. Measured across eight
  // repositories, 60 calls reach a real vendor this way — gmail, Anthropic,
  // Microsoft Graph, PagerDuty, Azure — and every one of them was being
  // reported as a URL nobody could read. The constant is right there in the
  // file and cannot change, so resolving it is reading, not guessing.
  const calls = find(`
    const BASE = 'https://api.acme.com';
    await fetch(\`\${BASE}/v1/charges\`);
  `);
  assert.equal(calls[0]?.resolved, true);
  assert.equal(calls[0]?.host, 'api.acme.com');
  assert.equal(calls[0]?.route, '/v1/charges');
});

test('a constant resolves the host and leaves the unknowns unknown', () => {
  const calls = find(`
    const BASE = 'https://api.acme.com';
    await fetch(\`\${BASE}/v1/charges/\${id}\`);
  `);
  assert.equal(calls[0]?.route, '/v1/charges/{}', 'the id is still a runtime value');
});

test('a reassignable binding is not read, because it may not hold that value', () => {
  // `const` cannot change after its initializer; `let` and `var` can, and a
  // value read here would be a value assumed. The whole point of resolving the
  // constant is that the file guarantees it.
  const calls = find(`
    let base = 'https://api.acme.com';
    await fetch(\`\${base}/v1/charges\`);
  `);
  assert.equal(calls[0]?.resolved, false);
  assert.match(calls[0]?.reason ?? '', /host is substituted/i);
});

test('a name declared twice with different values is not read', () => {
  // Two functions each declaring their own `url` is ordinary code, and picking
  // either one would attribute a call to whichever vendor happened to be
  // collected last.
  const calls = find(`
    function a() { const BASE = 'https://api.acme.com'; return fetch(\`\${BASE}/v1/a\`); }
    function b() { const BASE = 'https://api.other.com'; return fetch(\`\${BASE}/v1/b\`); }
  `);
  assert.equal(calls[0]?.resolved, false, 'ambiguous, so unread rather than guessed');
  assert.equal(calls[1]?.resolved, false);
});

test('a constant that is not an absolute URL stays out of scope', () => {
  const calls = find(`
    const BASE = '/api/internal';
    await fetch(\`\${BASE}/thing\`);
  `);
  assert.equal(calls[0]?.resolved, false);
  assert.match(calls[0]?.reason ?? '', /relative/i);
});

test('`request` is not treated as an HTTP client', () => {
  // Measured across six repositories: of 3,079 calls matching the client list,
  // some 2,300 were `request(app.getHttpServer())` from supertest or
  // `request.get('Authorization')` from Express reading a header. None is an
  // outbound call, and every one of them was being counted into the
  // "could not be checked" total a user is shown — overstating what Emend
  // failed to read, and burying the calls it genuinely could not.
  //
  // The npm package of that name was deprecated in 2020. The identifier is far
  // more often somebody's request object, and it is not worth the noise.
  const calls = find(`
    request.get('Authorization');
    request(app.getHttpServer());
    request('https://api.acme.com/v1/charges');
  `);
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// A base URL another module declares
// ---------------------------------------------------------------------------

test('an exported absolute URL is collected; anything else is not', () => {
  // Only absolute URLs, because the whole point is unlocking a host. A path
  // fragment resolves nothing on its own — the host stays substituted and the
  // call is refused anyway — and every extra name is another chance for two
  // modules to disagree about what it means.
  const found = exportedUrlConstants(`
    export const API_BASE = 'https://api.acme.com';
    export const VERSION = 'v1';
    const PRIVATE_BASE = 'https://internal.acme.com';
    export let MUTABLE = 'https://mutable.acme.com';
  `);
  assert.deepEqual([...found], [['API_BASE', 'https://api.acme.com']]);
});

test('two modules exporting the same name differently cancel out', () => {
  // The intra-file ambiguity rule at repository scope. Picking one would
  // attribute a call to whichever module happened to be read second.
  const merged = mergeExportedConstants([
    new Map([['BASE', 'https://api.acme.com']]),
    new Map([['BASE', 'https://api.other.com']]),
    new Map([['ONLY', 'https://api.only.com']]),
  ]);
  assert.deepEqual([...merged], [['ONLY', 'https://api.only.com']]);
});

test('a constant imported from another module resolves the host', () => {
  // The largest remaining shape: 362 calls across eight repositories whose base
  // URL is declared in a different file. Nothing about the call is ambiguous —
  // the file says where the name comes from and one module defines it.
  const calls = findHttpCalls(
    'src/pay.ts',
    `import { API_BASE } from './config';
     await fetch(\`\${API_BASE}/v1/charges\`);`,
    new Map([['API_BASE', 'https://api.acme.com']]),
  );
  assert.equal(calls[0]?.resolved, true);
  assert.equal(calls[0]?.host, 'api.acme.com');
  assert.equal(calls[0]?.route, '/v1/charges');
});

test('an aliased import is looked up by the name the other module exports', () => {
  const calls = findHttpCalls(
    'src/pay.ts',
    `import { API_BASE as BASE } from './config';
     await fetch(\`\${BASE}/v1/charges\`);`,
    new Map([['API_BASE', 'https://api.acme.com']]),
  );
  assert.equal(calls[0]?.host, 'api.acme.com');
});

test('a name the file never imported is not resolved from elsewhere', () => {
  // The guard that makes name-based lookup safe without resolving module paths.
  // `base` here is a parameter; some unrelated module exporting that name says
  // nothing about it, and substituting would invent a vendor.
  const calls = findHttpCalls(
    'src/pay.ts',
    `export async function charge(base: string) {
       return fetch(\`\${base}/v1/charges\`);
     }`,
    new Map([['base', 'https://api.acme.com']]),
  );
  assert.equal(calls[0]?.resolved, false);
  assert.match(calls[0]?.reason ?? '', /host is substituted/i);
});

test('a file may take one base from another module and declare another itself', () => {
  // A name cannot be both imported and declared in one module, so the two
  // sources never contend for the same identifier. What matters is that
  // enabling the wider lookup does not disturb the local one.
  const calls = findHttpCalls(
    'src/pay.ts',
    `import { REMOTE } from './config';
     const LOCAL = 'https://local.acme.com';
     await fetch(\`\${REMOTE}/v1/charges\`);
     await fetch(\`\${LOCAL}/v1/refunds\`);`,
    new Map([['REMOTE', 'https://remote.acme.com']]),
  );
  assert.deepEqual(
    calls.map((c) => c.host),
    ['remote.acme.com', 'local.acme.com'],
  );
});

// ---------------------------------------------------------------------------
// A request written as an options object
// ---------------------------------------------------------------------------

test('a call taking { method, url } is a request, whoever wrote the function', () => {
  // Recognised by the shape of the argument rather than the name of the callee.
  // `axios({ method, url })` is axios's own documented form and was unreadable
  // too, so this is not a special case for one project's wrapper — it is the
  // shape every hand-rolled client copies. Measured across five repositories:
  // 3,718 calls carry both properties and 2,119 of those name an absolute URL,
  // against a total of about 112 calls Emend could read at all.
  const calls = find(`
    await httpClient.sendRequest({ method: 'GET', url: 'https://api.acme.com/v1/charges' });
    await axios({ method: 'post', url: 'https://api.acme.com/v1/refunds' });
  `);
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.host}${c.route}`),
    ['GET api.acme.com/v1/charges', 'POST api.acme.com/v1/refunds'],
  );
});

test('a method named through a constant is read, not defaulted', () => {
  // activepieces writes `method: HttpMethod.POST`. Reading the property's name
  // is what keeps a POST from being recorded as a GET — and a GET recorded
  // against an endpoint the description only offers as POST is a false finding
  // of exactly the kind this tier keeps producing when it guesses.
  const calls = find(`
    await httpClient.sendRequest({ method: HttpMethod.POST, url: 'https://api.acme.com/v1/charges' });
  `);
  assert.equal(calls[0]?.method, 'POST');
});

test('a method that cannot be read leaves the call unread', () => {
  // The alternative is defaulting to GET, which invents a request the code does
  // not make. `fetch(url)` with no method genuinely is a GET; an options object
  // that declares a method Emend cannot evaluate is a question, not an answer.
  const calls = find(`
    await httpClient.sendRequest({ method: options.method, url: 'https://api.acme.com/v1/charges' });
  `);
  assert.equal(calls[0]?.resolved, false);
  assert.match(calls[0]?.reason ?? '', /method/i);
});

test('an object with a url but no method is not a request', () => {
  // Measured noise: `z.object({ url: z.string() })`, config builders, metadata.
  // The method property is what separates a request from a record about one.
  const calls = find(`
    const schema = z.object({ url: z.string() });
    const meta = { name: 'docs', url: 'https://api.acme.com/v1/charges' };
  `);
  assert.deepEqual(calls, []);
});

test('uri is the same property under another name', () => {
  const calls = find(`await client.request({ method: 'GET', uri: 'https://api.acme.com/v1/charges' });`);
  assert.equal(calls[0]?.host, 'api.acme.com');
});

test('a framework injecting its own routes invents no vendor', () => {
  // Fastify's test helper is `app.inject({ method, url })` and matches this
  // shape exactly — 547 calls across the repositories measured. Its URLs are
  // relative, so they resolve to the application's own server and are refused
  // there, which is where that guard was always meant to catch them.
  const calls = find(`await app.inject({ method: 'GET', url: '/api/internal/health' });`);
  assert.equal(calls[0]?.resolved, false);
  assert.match(calls[0]?.reason ?? '', /relative/i);
});

// ---------------------------------------------------------------------------
// Matching a version diff onto call sites
// ---------------------------------------------------------------------------

// `matchAgainstDiff` is the other half of this tier: `checkAgainstSpec` asks
// whether a route is in today's description and so can never see a deprecation,
// because a deprecated endpoint is still described. Only a diff between two
// versions carries that.
//
// It was matching routes the way `checkAgainstSpec` did before the base path
// and spanning fixes, and the consequence was measured: seventeen vendors mined
// against activepieces, n8n and sim — including 175 breaking or deprecated
// Klaviyo changes and 112 GitHub ones — produced zero hits. Not because nothing
// was reached, but because nothing could match.
const REFS_SPEC = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'GitHub', version: '1' },
  paths: { '/repos/{owner}/{repo}/git/refs/{ref}': { get: {} } },
});

test('a removed endpoint matches the call that spells its parameter out', () => {
  const calls = findHttpCalls('src/gh.ts', 'await fetch(`https://api.github.com/repos/${o}/${r}/git/refs/heads/${b}`);');
  const hits = matchAgainstDiff(
    calls,
    'api.github.com',
    [change('GET /repos/{owner}/{repo}/git/refs/{ref}', 'removed', 'breaking')],
    REFS_SPEC,
  );
  assert.equal(hits.length, 1, 'heads/${b} is the {ref} the description names');
  assert.equal(hits[0]?.sites[0]?.file, 'src/gh.ts');
});

test('a version diff is aligned to the description’s base path too', () => {
  const spec = JSON.stringify({
    swagger: '2.0',
    info: { title: 'Slack', version: '1' },
    basePath: '/api',
    paths: { '/channels.list': { get: {} } },
  });
  const calls = findHttpCalls('src/slack.ts', `await fetch('https://slack.com/api/channels.list');`);
  const hits = matchAgainstDiff(calls, 'slack.com', [change('GET /channels.list', 'removed', 'breaking')], spec);
  assert.equal(hits.length, 1);
});

test('without a description the diff still matches what it plainly can', () => {
  // The regression guard: callers that have no spec to hand keep working, and
  // an exact route still lands on its call site.
  const hits = matchAgainstDiff(CALLS, 'api.stripe.com', [change('POST /v1/charges', 'removed', 'breaking')]);
  assert.equal(hits.length, 1);
});
