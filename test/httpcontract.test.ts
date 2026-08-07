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

function candidate(over: Partial<SpecCandidate> = {}): SpecCandidate {
  return {
    vendor: 'api.acme.com',
    url: 'https://api.acme.com/openapi.json',
    provenance: 'official-domain',
    fetchedAt: '2026-08-07T00:00:00.000Z',
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

test('nothing is claimed from a description that is not the provider’s word', () => {
  // The rule `specs.ts` exists to enforce, applied where it bites. Telling
  // somebody their integration is broken on the strength of a copy that may be
  // years stale is the false certainty every honesty rule here prevents, and to
  // a reader it is indistinguishable from a real finding.
  const source = `await fetch('https://api.acme.com/v1/invoices/upcoming');`;
  const result = checkAgainstSpec(calls(source), 'api.acme.com', candidate({ provenance: 'aggregator-apis-guru' }));
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
  const findings = await detector.detect(ctx);
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
  assert.deepEqual(await detector.detect(context(APP)), []);
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
