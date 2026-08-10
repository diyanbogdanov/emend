import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAgainstSpec, findHttpCalls } from '../src/httpsites.ts';
import { httpContractDetector } from '../src/detectors.ts';
import type { SpecCandidate } from '../src/specs.ts';

const SPEC = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Acme', version: '1' },
  paths: {
    '/v1/charges': { post: {}, get: {} },
    '/v1/charges/{charge}': { get: {} },
  },
});

// Several fixtures below are `official-github`, which is a stored copy and so
// has to say when the provider last changed it before it may assert anything.
// Computed rather than written down: these tests are about matching routes, and
// a literal date would quietly turn them red a year from now.
const RECENTLY = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

function candidate(over: Partial<SpecCandidate> = {}): SpecCandidate {
  return {
    vendor: 'api.acme.com',
    url: 'https://api.acme.com/openapi.json',
    provenance: 'official-domain',
    fetchedAt: '2026-08-07T00:00:00.000Z',
    updatedAt: RECENTLY,
    body: SPEC,
    ...over,
  };
}

function calls(source: string) {
  return findHttpCalls('src/pay.ts', source);
}

const GOOD = `
  await fetch('https://api.acme.com/v1/charges', { method: 'POST' });
  await fetch(\`https://api.acme.com/v1/charges/\${id}\`);
`;

test('calls that the description still contains produce nothing', () => {
  const result = checkAgainstSpec(calls(GOOD), 'api.acme.com', candidate());
  assert.deepEqual(result.gone, []);
  assert.equal(result.matched, 2);
});

test('a call to an endpoint the description no longer has is reported', () => {
  const source = `${GOOD}
    await fetch('https://api.acme.com/v1/invoices/upcoming');
  `;
  const result = checkAgainstSpec(calls(source), 'api.acme.com', candidate());
  assert.equal(result.gone.length, 1);
  assert.equal(result.gone[0]?.route, '/v1/invoices/upcoming');
});

// A description states its paths relative to a base the call site must spell in
// full. Slack's own Swagger says `basePath: "/api"` and lists `/auth.test`,
// while every call in every repository reads `https://slack.com/api/auth.test`.
// Without aligning the two, no call ever matches, `matched` stays zero, and the
// vendor with the clearest drift story in the industry — `channels.*` retired
// in favour of `conversations.*` — can never produce a finding. The failure is
// silent and reads exactly like a clean integration.
const SLACK = JSON.stringify({
  swagger: '2.0',
  info: { title: 'Slack Web API', version: '1' },
  host: 'slack.com',
  basePath: '/api',
  paths: {
    '/auth.test': { post: {} },
    '/conversations.list': { get: {} },
  },
});

function slack(over: Partial<SpecCandidate> = {}): SpecCandidate {
  return {
    vendor: 'slack.com',
    url: 'https://raw.githubusercontent.com/slackapi/slack-api-specs/master/web-api/slack_web_openapi_v2.json',
    provenance: 'official-github',
    fetchedAt: '2026-08-09T00:00:00.000Z',
    // The real one has not changed since 2020 and so may assert nothing; that
    // is its own test in specs.test.ts. Here the base path is what is measured.
    updatedAt: RECENTLY,
    body: SLACK,
    ...over,
  };
}

test('a description’s base path is spelled out by the call site, and the two align', () => {
  const source = `
    await fetch('https://slack.com/api/auth.test', { method: 'POST' });
    await fetch('https://slack.com/api/conversations.list');
  `;
  const result = checkAgainstSpec(findHttpCalls('src/slack.ts', source), 'slack.com', slack());
  assert.equal(result.matched, 2, 'basePath /api plus /auth.test is the call site’s /api/auth.test');
  assert.deepEqual(result.gone, []);
  assert.equal(result.note, undefined);
});

test('an endpoint the provider retired is reported once the base path aligns', () => {
  // The finding this whole tier exists for. `channels.list` is absent from
  // Slack's own description; `conversations.list` replaced it.
  const source = `
    await fetch('https://slack.com/api/conversations.list');
    await fetch('https://slack.com/api/channels.list');
  `;
  const result = checkAgainstSpec(findHttpCalls('src/slack.ts', source), 'slack.com', slack());
  assert.equal(result.gone.length, 1);
  assert.equal(result.gone[0]?.route, '/api/channels.list');
});

test('an OpenAPI 3 server URL carrying a path is a base path too', () => {
  const spec = JSON.stringify({
    openapi: '3.0.0',
    info: { title: 'Acme', version: '1' },
    servers: [{ url: 'https://api.acme.com/v2' }],
    paths: { '/charges': { get: {} } },
  });
  const source = `await fetch('https://api.acme.com/v2/charges');`;
  const result = checkAgainstSpec(findHttpCalls('src/pay.ts', source), 'api.acme.com', candidate({ body: spec }));
  assert.equal(result.matched, 1);
});

test('a description whose paths are already absolute keeps working', () => {
  // The regression guard. Most descriptions have no base path at all, and
  // prefixing one that is not there would break every vendor that works today.
  const result = checkAgainstSpec(calls(GOOD), 'api.acme.com', candidate());
  assert.equal(result.matched, 2);
});

// GitHub states `/repos/{owner}/{repo}/git/matching-refs/{ref}` and every real
// call spells the ref out as `heads/main` — two segments where the description
// has one. Comparing segment counts made a correct, modern call look like a call
// to an endpoint that no longer exists, which is the one failure mode that costs
// more than silence: a pull request "fixing" working code. Measured on
// live-codes/livecodes, where two of two findings were this.
const REFS = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'GitHub', version: '1' },
  paths: {
    '/repos/{owner}/{repo}/git/matching-refs/{ref}': { get: {} },
    '/repos/{owner}/{repo}/git/refs/{ref}': { patch: {}, delete: {} },
    '/repos/{owner}/{repo}/git/ref/{ref}': { get: {} },
  },
});

const github = (): SpecCandidate =>
  candidate({ vendor: 'api.github.com', provenance: 'official-github', body: REFS });

test('a path parameter that spans slashes matches the call that spells it out', () => {
  const source = `await fetch(\`https://api.github.com/repos/\${o}/\${r}/git/matching-refs/heads/\${b}\`);`;
  const result = checkAgainstSpec(findHttpCalls('src/gh.ts', source), 'api.github.com', github());
  assert.equal(result.matched, 1);
  assert.deepEqual(result.gone, [], 'heads/${b} is the {ref} the description names');
});

test('a spanning parameter does not excuse a route the description really lacks', () => {
  // The guard on the guard. GitHub retired `GET .../git/refs/{ref}` in favour of
  // `git/ref/{ref}`; `refs` and `ref` are different literal segments, so
  // permitting a parameter to span slashes must not quietly match them up.
  const source = `await fetch(\`https://api.github.com/repos/\${o}/\${r}/git/refs/heads/\${b}\`);
    await fetch(\`https://api.github.com/repos/\${o}/\${r}/git/matching-refs/heads/\${b}\`);`;
  const result = checkAgainstSpec(findHttpCalls('src/gh.ts', source), 'api.github.com', github());
  assert.equal(result.gone.length, 1);
  assert.equal(result.gone[0]?.route, '/repos/{}/{}/git/refs/heads/{}');
});

test('a parameter does not span where the description defines something deeper', () => {
  // The limit that keeps spanning from swallowing the signal. `{repo}` in
  // `/repos/{owner}/{repo}` is trailing, but the description defines routes
  // beneath it, so it plainly means one segment. Letting it span would match
  // every call to the host and no GitHub finding could ever be reported again.
  const spec = JSON.stringify({
    openapi: '3.0.0',
    info: { title: 'GitHub', version: '1' },
    paths: {
      '/repos/{owner}/{repo}': { get: {} },
      '/repos/{owner}/{repo}/branches/{branch}': { get: {} },
    },
  });
  // One call that plainly aligns, so the "could not be aligned" guard stays out
  // of the way and this measures the spanning rule rather than that guard.
  const source = `
    await fetch('https://api.github.com/repos/acme/widget');
    await fetch('https://api.github.com/repos/acme/widget/pulls/5/comments');
  `;
  const result = checkAgainstSpec(
    findHttpCalls('src/gh.ts', source),
    'api.github.com',
    candidate({ vendor: 'api.github.com', provenance: 'official-github', body: spec }),
  );
  assert.equal(result.matched, 1);
  assert.equal(result.gone.length, 1, 'nothing described reaches it, and {repo} may not span to cover that');
  assert.equal(result.gone[0]?.route, '/repos/acme/widget/pulls/5/comments');
});

// The mirror of the spanning problem, on the call's side. `${project.repo}` is
// one substitution holding "owner/name", so the call reads `/repos/{}/git/...`
// where the description has two parameters. Measured on fastrepl/anarlog: eight
// findings, of which seven were this — including `DELETE .../git/refs/{ref}`
// and `POST .../git/refs`, both of which GitHub documents.
test('one substitution may stand for several parameters the description names', () => {
  const spec = JSON.stringify({
    openapi: '3.0.0',
    info: { title: 'GitHub', version: '1' },
    paths: {
      '/repos/{owner}/{repo}': { get: {} },
      '/repos/{owner}/{repo}/git/refs': { post: {} },
      '/repos/{owner}/{repo}/git/blobs/{file_sha}': { get: {} },
    },
  });
  const source = `
    await fetch(\`https://api.github.com/repos/\${slug}\`);
    await fetch(\`https://api.github.com/repos/\${slug}/git/refs\`, { method: 'POST' });
    await fetch(\`https://api.github.com/repos/\${slug}/git/blobs/\${sha}\`);
  `;
  const result = checkAgainstSpec(
    findHttpCalls('src/gh.ts', source),
    'api.github.com',
    candidate({ vendor: 'api.github.com', provenance: 'official-github', body: spec }),
  );
  assert.equal(result.matched, 3);
  assert.deepEqual(result.gone, []);
});

test('a substitution stands for parameters, never for a literal in the route', () => {
  // The limit that keeps the call side from swallowing the signal too. If a
  // substitution could absorb `git`, then `.../git/refs/heads/x` would match
  // `.../git/ref/{ref}` by absorbing the very segment that differs — and
  // `refs` versus `ref` is exactly the drift this tier exists to report.
  const source = `await fetch(\`https://api.github.com/repos/\${o}/\${r}/git/refs/heads/\${b}\`);
    await fetch(\`https://api.github.com/repos/\${o}/\${r}/git/ref/heads/\${b}\`);`;
  const result = checkAgainstSpec(findHttpCalls('src/gh.ts', source), 'api.github.com', github());
  assert.equal(result.matched, 1, 'the singular route is the one that is described');
  assert.equal(result.gone.length, 1);
  assert.equal(result.gone[0]?.route, '/repos/{}/{}/git/refs/heads/{}');
});

test('nothing is claimed from a description that is not the provider’s word', () => {
  // The rule `specs.ts` exists to enforce, applied where it bites. Telling
  // somebody their integration is broken on the strength of a copy that may be
  // years stale is the false certainty every honesty rule here prevents, and to
  // a reader it is indistinguishable from a real finding.
  const source = `await fetch('https://api.acme.com/v1/invoices/upcoming');`;
  const result = checkAgainstSpec(calls(source), 'api.acme.com', candidate({ provenance: 'community' }));
  assert.deepEqual(result.gone, []);
  assert.match(result.note ?? '', /not authoritative/i);
});

test('a templated route covers a literal call, which is a real gap and the safe one', () => {
  // Measured against Stripe. `GET /v1/invoices/upcoming` is genuinely gone from
  // today's description, but `GET /v1/invoices/{invoice}` is not — so the call
  // still matches a described route and this check stays quiet.
  //
  // Kept deliberately. Requiring a literal to match a literal would report every
  // hardcoded identifier — `/v1/charges/ch_123` — as a vanished endpoint, and a
  // false break is far worse here than a missed one: this check has no baseline
  // and its whole design is about not being confidently wrong.
  //
  // The precise answer needs a baseline, and `matchAgainstDiff` gives it: two
  // route sets compared exactly, where `/v1/invoices/upcoming` shows up as
  // removed. Two tools, two questions.
  const spec = JSON.stringify({
    openapi: '3.0.0',
    info: {},
    paths: { '/v1/invoices/{invoice}': { get: {} } },
  });
  const result = checkAgainstSpec(
    calls(`await fetch('https://api.acme.com/v1/invoices/upcoming');`),
    'api.acme.com',
    candidate({ body: spec }),
  );
  assert.equal(result.matched, 1);
  assert.deepEqual(result.gone, []);
});

test('a partial description cannot report the endpoints it simply does not cover', () => {
  // Reachable only since YAML became readable, and worth pinning. apis.io
  // publishes Stripe as 159 separate descriptions — "Account API", twelve
  // operations — so a fragment can match one call in a repository and know
  // nothing about the other nineteen. The misalignment guard does not catch that:
  // it only fires when *nothing* matches.
  //
  // What does catch it is provenance. A directory listing is not the provider's
  // word, so no claim is made from it at all, and the fragment is a lead rather
  // than a verdict. This asserts the containment rather than trusting it.
  const fragment = JSON.stringify({
    openapi: '3.0.0',
    info: {},
    paths: { '/v1/charges': { post: {} } },
  });
  const source = `
    await fetch('https://api.acme.com/v1/charges', { method: 'POST' });
    await fetch('https://api.acme.com/v1/invoices');
    await fetch('https://api.acme.com/v1/refunds');
  `;
  const result = checkAgainstSpec(
    calls(source),
    'api.acme.com',
    candidate({ provenance: 'directory', body: fragment }),
  );
  assert.deepEqual(result.gone, [], 'the two endpoints it never described are not reported');
  assert.match(result.note ?? '', /not authoritative/i);
});

test('when no call matches anything, the description is misaligned, not the code', () => {
  // The guard against the worst failure this detector could have. If a base path
  // or a host convention means none of the routes line up, the honest reading is
  // that the matching is wrong — not that every endpoint the customer calls has
  // been deleted. Reporting the latter would be a page of confident nonsense.
  const source = `
    await fetch('https://api.acme.com/rest/2024/charges', { method: 'POST' });
    await fetch('https://api.acme.com/rest/2024/refunds', { method: 'POST' });
  `;
  const result = checkAgainstSpec(calls(source), 'api.acme.com', candidate());
  assert.deepEqual(result.gone, []);
  assert.equal(result.matched, 0);
  assert.match(result.note ?? '', /could not be aligned/i);
});

test('an unreadable description yields no claims at all', () => {
  const result = checkAgainstSpec(calls(GOOD), 'api.acme.com', candidate({ body: '<html>no</html>' }));
  assert.deepEqual(result.gone, []);
  assert.match(result.note ?? '', /could not be read/i);
});

test('calls that could not be read are counted, so no report reads as all-clear', () => {
  const source = `${GOOD}
    await fetch(somethingDynamic);
  `;
  const result = checkAgainstSpec(calls(source), 'api.acme.com', candidate());
  assert.equal(result.unresolvedCalls, 1);
});

// ---------------------------------------------------------------------------
// The detector
// ---------------------------------------------------------------------------

function context(files: Record<string, string>) {
  return {
    repoDir: '/repo',
    dependencies: [],
    sourceFiles: Object.keys(files),
    read: async (file: string) => files[file] ?? null,
  };
}

const APP = {
  'src/billing.ts': `${GOOD}
    await fetch('https://api.acme.com/v1/invoices/upcoming');
  `,
};

test('a call to a vanished endpoint becomes a finding pointing at its line', async () => {
  const detector = httpContractDetector({ resolve: async () => [candidate()] });
  const ctx = context(APP);

  assert.equal(await detector.applies(ctx), true);
  const { findings } = await detector.detect(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.detector, 'http-contract');
  assert.equal(findings[0]?.pkg, 'api.acme.com');
  assert.equal(findings[0]?.change.path, 'GET /v1/invoices/upcoming');
  assert.equal(findings[0]?.change.severity, 'breaking');
  // Medium, not high. The endpoint really is absent from the provider's own
  // description, but whether this call is the one that breaks depends on things
  // no description records.
  assert.equal(findings[0]?.confidence, 'medium');
  assert.equal(findings[0]?.sites[0]?.file, 'src/billing.ts');
});

test('no description located means no findings, not a clean result', async () => {
  // The two are the same output here — an empty list — and the difference is
  // carried by the detector never asserting anything it did not check. What must
  // not happen is a crash, or a finding invented from an absence.
  const detector = httpContractDetector({ resolve: async () => [] });
  assert.deepEqual((await detector.detect(context(APP))).findings, []);
});

test('a repository with no readable outbound call does not reach the network', async () => {
  // `applies` is a precondition, not a hint. This is the only detector that
  // makes outbound requests, and it must not make them to answer whether it has
  // any work.
  let resolved = 0;
  const detector = httpContractDetector({
    resolve: async () => {
      resolved++;
      return [candidate()];
    },
  });
  const ctx = context({ 'src/pure.ts': 'export const add = (a: number, b: number) => a + b;' });
  assert.equal(await detector.applies(ctx), false);
  assert.equal(resolved, 0);
});

test('the number of hosts a scan will resolve is bounded, and the bound is a choice', async () => {
  // A repository talking to thirty services should not turn one scan into thirty
  // resolutions without somebody choosing that.
  let resolved = 0;
  const detector = httpContractDetector({
    maxHosts: 2,
    resolve: async () => {
      resolved++;
      return [];
    },
  });
  await detector.detect(
    context({
      'src/many.ts': `
        await fetch('https://a.example.com/v1/x');
        await fetch('https://b.example.com/v1/x');
        await fetch('https://c.example.com/v1/x');
      `,
    }),
  );
  assert.equal(resolved, 2);
});

test('the detector resolves a base URL one file exports and another calls', async () => {
  // The wiring is the whole feature: `findHttpCalls` cannot see a second file,
  // so the detector gathers the repository's exported base URLs first and hands
  // them down. Measured as 362 calls across eight repositories that read as
  // unresolvable while their base URL sat one import away.
  const detector = httpContractDetector({ resolve: async () => [candidate()] });
  const { findings } = await detector.detect(
    context({
      'src/config.ts': `export const API_BASE = 'https://api.acme.com';`,
      'src/billing.ts': `import { API_BASE } from './config';
        await fetch(\`\${API_BASE}/v1/charges\`, { method: 'POST' });
        await fetch(\`\${API_BASE}/v1/invoices/upcoming\`);`,
    }),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.change.path, 'GET /v1/invoices/upcoming');
  assert.equal(findings[0]?.sites[0]?.file, 'src/billing.ts');
});

test('the detector still runs where no call reads on its own', async () => {
  // `applies` used to require a call that resolved standalone, which is exactly
  // what a repository keeping its base URLs in one module never has. Gating on
  // it would skip the repositories cross-module resolution was added for.
  const detector = httpContractDetector({ resolve: async () => [candidate()] });
  const applies = await detector.applies(
    context({
      'src/config.ts': `export const API_BASE = 'https://api.acme.com';`,
      'src/billing.ts': `import { API_BASE } from './config';
        await fetch(\`\${API_BASE}/v1/invoices/upcoming\`);`,
    }),
  );
  assert.equal(applies, true);
});

// ---------------------------------------------------------------------------
// A description that does not cover where the call goes
// ---------------------------------------------------------------------------

// One host may serve several APIs, each with its own description, and the
// resolver brings back one of them. Xero's `api.xero.com` resolved
// `xero_accounting.yaml` — 138 paths, all /Accounts and /Invoices — while the
// call was `/projects.xro/2.0/Projects`, which lives in a different Xero
// document entirely. GitHub is the same shape: its REST description has no
// `/graphql`, and the GraphQL API is not missing, it is described elsewhere.
//
// Absence from the description in hand is not absence from the API. The signal
// that separates the two is whether the description names anything at all under
// the same top-level path: a real removal leaves its neighbours behind, and
// `/repos/{owner}/{repo}/git/refs/{ref}` still has its PATCH and DELETE.
const PARTIAL = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Xero Accounting API', version: '1' },
  paths: {
    '/Accounts': { get: {} },
    '/Accounts/{AccountID}': { get: {} },
    '/Invoices': { get: {} },
  },
});

const partial = (): SpecCandidate =>
  candidate({ vendor: 'api.xero.com', provenance: 'official-domain', body: PARTIAL });

test('a call under a path the description never mentions is not a removal', () => {
  const source = `
    await fetch('https://api.xero.com/Accounts');
    await fetch('https://api.xero.com/projects.xro/2.0/Projects');
  `;
  const result = checkAgainstSpec(findHttpCalls('src/xero.ts', source), 'api.xero.com', partial());
  assert.equal(result.matched, 1);
  assert.deepEqual(result.gone, [], 'this description is not a description of the Projects API');
});

test('a path the description does not cover is reported as unchecked, not dropped', () => {
  // The rule this whole detector turns on. Suppressing the claim is right;
  // suppressing the fact that nobody checked would be the same silence the
  // "could not check is not checked and clean" rule exists to prevent.
  const source = `
    await fetch('https://api.xero.com/Accounts');
    await fetch('https://api.xero.com/projects.xro/2.0/Projects');
  `;
  const result = checkAgainstSpec(findHttpCalls('src/xero.ts', source), 'api.xero.com', partial());
  assert.deepEqual(result.uncovered, ['/projects.xro']);
});

test('a removal inside a path the description does cover is still reported', () => {
  // The regression guard, and the reason coverage is judged by the top-level
  // path rather than by whether anything nearby matched. GitHub describes
  // `/repos/.../git/refs/{ref}` for patch and delete, so the region is plainly
  // covered and the missing GET is a real finding — this is XPoet/picx.
  const source = `await fetch(\`https://api.github.com/repos/\${o}/\${r}/git/refs/heads/\${b}\`);
    await fetch(\`https://api.github.com/repos/\${o}/\${r}/git/ref/heads/\${b}\`);`;
  const result = checkAgainstSpec(findHttpCalls('src/gh.ts', source), 'api.github.com', github());
  assert.equal(result.gone.length, 1);
  assert.equal(result.gone[0]?.route, '/repos/{}/{}/git/refs/heads/{}');
  assert.deepEqual(result.uncovered, []);
});
