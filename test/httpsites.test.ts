import test from 'node:test';
import assert from 'node:assert/strict';
import { findHttpCalls, matchAgainstDiff } from '../src/httpsites.ts';
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

test('features are not reported as work, because nothing has to change', () => {
  // A new optional parameter on an endpoint someone calls is not a task. Raising
  // it would bury the seven real breaks in a hundred and eighty-three additions.
  assert.deepEqual(
    matchAgainstDiff(CALLS, 'api.stripe.com', [change('POST /v1/charges', 'added', 'feature')]),
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
