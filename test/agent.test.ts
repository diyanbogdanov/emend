import test from 'node:test';
import assert from 'node:assert/strict';
import { nearbySymbols } from '../src/harness.ts';

import type { CallSite, Finding, SurfaceChange } from '../src/types.ts';

function targetSymbols(
  entries: Array<[string, boolean?]>,
): Record<string, { path: string; deprecated: boolean }> {
  return Object.fromEntries(
    entries.map(([path, deprecated]) => [path, { path, deprecated: deprecated === true }]),
  );
}

// ---------------------------------------------------------------------------
// nearbySymbols
// ---------------------------------------------------------------------------

test('offers a symbol that moved to a different container', () => {
  // A migration that relocates a helper is a stated tier-2 target. Ranking only
  // within the changed symbol's own container means the replacement is filtered
  // out before scoring ever sees it, so the model is told to use "only symbols
  // from this list" and the list cannot contain the answer.
  const candidates = nearbySymbols(
    'record',
    targetSymbols([['object'], ['string'], ['core.record'], ['number']]),
  );
  assert.ok(
    candidates.includes('core.record'),
    `a relocated symbol must be offered; got ${JSON.stringify(candidates)}`,
  );
});

test('ranks a relocated exact match above unrelated same-container symbols', () => {
  const candidates = nearbySymbols(
    'record',
    targetSymbols([['object'], ['string'], ['core.record'], ['number']]),
  );
  assert.ok(
    candidates.indexOf('core.record') < candidates.indexOf('object'),
    `relocated exact match must outrank unrelated siblings; got ${JSON.stringify(candidates)}`,
  );
});

test('still ranks a same-container near-name match near the front', () => {
  // Regression guard: zod 4's `partialRecord` replaces a broken `record` call and
  // was once buried past the prompt's cutoff by alphabetical ordering.
  const candidates = nearbySymbols(
    'record',
    targetSymbols([['array'], ['bigint'], ['object'], ['partialRecord'], ['string']]),
  );
  assert.ok(
    candidates.indexOf('partialRecord') < 2,
    `partialRecord must stay near the front; got ${JSON.stringify(candidates)}`,
  );
});

test('never offers a deprecated symbol as a replacement', () => {
  const candidates = nearbySymbols(
    'record',
    targetSymbols([['partialRecord', true], ['object']]),
  );
  assert.ok(!candidates.includes('partialRecord'));
});
