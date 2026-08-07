import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVENANCE_RANK,
  bestSpec,
  canAssertBreakage,
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
    candidate({ provenance: 'aggregator-apis-guru', url: 'https://apis.guru/stripe.json' }),
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
  // The order is the whole model: everything above `curated` is controlled by
  // the provider or verified as theirs; everything below is somebody's copy.
  assert.ok(PROVENANCE_RANK['official-domain'] > PROVENANCE_RANK['official-github']);
  assert.ok(PROVENANCE_RANK['official-github'] > PROVENANCE_RANK['verified-swaggerhub']);
  assert.ok(PROVENANCE_RANK['verified-postman'] > PROVENANCE_RANK['curated']);
  assert.ok(PROVENANCE_RANK['curated'] > PROVENANCE_RANK['aggregator-apis-guru']);
  assert.ok(PROVENANCE_RANK['aggregator-apis-guru'] > PROVENANCE_RANK['extracted-from-docs']);
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
  assert.equal(canAssertBreakage(candidate({ provenance: 'aggregator-apis-guru' })), false);
  assert.equal(canAssertBreakage(candidate({ provenance: 'extracted-from-docs' })), false);
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
