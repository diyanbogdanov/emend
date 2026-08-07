import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVENANCE_RANK,
  SPEC_SOURCES,
  bestSpec,
  canAssertBreakage,
  provenanceOfPointer,
  wellKnownSpecPaths,
  type SpecCandidate,
} from '../src/specs.ts';

function candidate(over: Partial<SpecCandidate> = {}): SpecCandidate {
  return {
    vendor: 'stripe',
    url: 'https://stripe.com/openapi.json',
    provenance: 'official-domain',
    fetchedAt: '2026-08-07T00:00:00.000Z',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Provenance decides what Emend is willing to claim, not merely where a file
// came from.
// ---------------------------------------------------------------------------

test('a first-party spec outranks every aggregator copy of it', () => {
  // An aggregator's copy lags its source by an unknown amount, so a difference
  // between them is as likely to be staleness as a real API change. Only the
  // provider controls the truth.
  const chosen = bestSpec([
    candidate({ provenance: 'community', url: 'https://someone.example/stripe.json' }),
    candidate({ provenance: 'curated', url: 'https://konfig/stripe.json' }),
    candidate({ provenance: 'official-domain', url: 'https://stripe.com/openapi.json' }),
  ]);
  assert.equal(chosen?.provenance, 'official-domain');
});

test('official GitHub beats a curated or community copy', () => {
  const chosen = bestSpec([
    candidate({ provenance: 'community' }),
    candidate({ provenance: 'curated' }),
    candidate({ provenance: 'official-github' }),
  ]);
  assert.equal(chosen?.provenance, 'official-github');
});

test('the ranking runs from provider-controlled down to inferred', () => {
  // The order is the whole model: the further from the provider, the less the
  // copy in hand says about the API.
  assert.ok(PROVENANCE_RANK['official-domain'] > PROVENANCE_RANK['official-github']);
  assert.ok(PROVENANCE_RANK['official-github'] > PROVENANCE_RANK['directory']);
  assert.ok(PROVENANCE_RANK['verified-swaggerhub'] > PROVENANCE_RANK['verified-postman']);
  assert.ok(PROVENANCE_RANK['verified-postman'] > PROVENANCE_RANK['curated']);
  assert.ok(PROVENANCE_RANK['curated'] > PROVENANCE_RANK['community']);
  assert.ok(PROVENANCE_RANK['community'] > PROVENANCE_RANK['extracted-from-docs']);
});

test('a directory of provider-published pointers outranks a third party’s copy', () => {
  // An APIs.json manifest is published *by the provider*, so an apis.io entry is
  // a pointer the provider chose. SwaggerHub and Postman hold copies — verified
  // ones, but still somebody else's bytes on somebody else's platform. A pointer
  // to the provider beats a copy of the provider.
  assert.ok(PROVENANCE_RANK['directory'] > PROVENANCE_RANK['verified-swaggerhub']);
  assert.ok(PROVENANCE_RANK['directory'] > PROVENANCE_RANK['verified-postman']);

  const chosen = bestSpec([
    candidate({ provenance: 'verified-swaggerhub' }),
    candidate({ provenance: 'verified-postman' }),
    candidate({ provenance: 'directory' }),
  ]);
  assert.equal(chosen?.provenance, 'directory');
});

test('the directory is consulted before the platforms that host copies', () => {
  // Consult order, not just rank: following the cheapest route that tends to
  // land on the provider avoids fetching a copy we would then have to discount.
  const order = SPEC_SOURCES.map((s) => s.id);
  assert.ok(order.indexOf('apis-io') < order.indexOf('swaggerhub'));
  assert.ok(order.indexOf('apis-io') < order.indexOf('postman'));
  // First-party still goes first — the directory is a route to it, not a rival.
  assert.ok(order.indexOf('well-known') < order.indexOf('apis-io'));
});

test('nothing at all yields nothing, rather than a default', () => {
  assert.equal(bestSpec([]), undefined);
});

// ---------------------------------------------------------------------------
// What a spec may be used to say
// ---------------------------------------------------------------------------

test('only a provider-controlled spec may assert that a call is broken', () => {
  // Telling someone their Stripe call breaks, on the strength of a community
  // copy that may be a year stale, is the false certainty every honesty rule in
  // this codebase exists to prevent. Emend can still report the call sites it
  // found and say the spec was not authoritative.
  assert.equal(canAssertBreakage(candidate({ provenance: 'official-domain' })), true);
  assert.equal(canAssertBreakage(candidate({ provenance: 'official-github' })), true);
  assert.equal(canAssertBreakage(candidate({ provenance: 'verified-swaggerhub' })), true);
  assert.equal(canAssertBreakage(candidate({ provenance: 'verified-postman' })), false);
  assert.equal(canAssertBreakage(candidate({ provenance: 'curated' })), false);
  assert.equal(canAssertBreakage(candidate({ provenance: 'extracted-from-docs' })), false);
});

test('preferring a source is not the same as trusting it', () => {
  // The reorder above is why these are two questions rather than one cutoff.
  // apis.io is the better route — it usually points at the provider — but when
  // the pointer lands on a third-party host, following a good route does not
  // make the destination first-party. Rank orders what to try; the authority
  // set decides what may be claimed. Folding them into one number means any
  // future reorder silently hands out claim rights.
  assert.ok(PROVENANCE_RANK['directory'] > PROVENANCE_RANK['verified-swaggerhub']);
  assert.equal(canAssertBreakage(candidate({ provenance: 'directory' })), false);
  assert.equal(canAssertBreakage(candidate({ provenance: 'verified-swaggerhub' })), true);
});

// ---------------------------------------------------------------------------
// Discovery source versus truth source
// ---------------------------------------------------------------------------

test('a pointer onto the provider’s own domain is first-party, whoever found it', () => {
  // The directory's value is that it usually points home. When it does, the
  // candidate is the provider's file — the route it arrived by does not
  // downgrade it. This is the whole discovery-versus-truth distinction: apis.io
  // told us where to look, stripe.com is what we read.
  assert.equal(
    provenanceOfPointer('https://stripe.com/openapi.json', 'stripe.com'),
    'official-domain',
  );
  assert.equal(
    provenanceOfPointer('https://api.stripe.com/v1/openapi.json', 'stripe.com'),
    'official-domain',
  );
});

test('a pointer onto somebody else’s host keeps the directory’s own standing', () => {
  // Only the residual case is the directory tier: apis.io listed it, but the
  // bytes live somewhere the provider does not control.
  assert.equal(
    provenanceOfPointer('https://cdn.example.net/stripe.json', 'stripe.com'),
    'directory',
  );
});

test('a pointer to the provider’s GitHub is first-party too', () => {
  assert.equal(
    provenanceOfPointer('https://raw.githubusercontent.com/stripe/openapi/master/spec3.json', 'stripe.com', 'stripe'),
    'official-github',
  );
  // …but only for the provider's own org. Anyone can host a mirror on GitHub.
  assert.equal(
    provenanceOfPointer('https://raw.githubusercontent.com/someone/stripe-mirror/main/spec.json', 'stripe.com', 'stripe'),
    'directory',
  );
});

test('a Postman collection is never treated as a contract', () => {
  // A collection carries real working requests, which makes it excellent for
  // discovery and for examples. It is not a complete description of the API, so
  // an endpoint absent from one says nothing about whether it exists.
  assert.equal(canAssertBreakage(candidate({ provenance: 'verified-postman' })), false);
});

// ---------------------------------------------------------------------------
// Where to look when nobody has told us
// ---------------------------------------------------------------------------

test('well-known paths are tried against the provider’s own origin', () => {
  const paths = wellKnownSpecPaths('https://api.linear.app');
  assert.ok(paths.some((p) => p.endsWith('/openapi.json')));
  assert.ok(paths.some((p) => p.endsWith('/openapi.yaml')));
  assert.ok(paths.some((p) => p.includes('/.well-known/')));
  assert.ok(paths.every((p) => p.startsWith('https://api.linear.app/')));
});

test('the swagger spellings are tried too, because half the web still uses them', () => {
  const paths = wellKnownSpecPaths('https://example.com');
  assert.ok(paths.some((p) => p.endsWith('/swagger.json')));
});

test('a malformed origin yields no candidates rather than a malformed URL', () => {
  assert.deepEqual(wellKnownSpecPaths('not a url'), []);
});
