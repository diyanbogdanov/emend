import test from 'node:test';
import assert from 'node:assert/strict';
import { Checkout } from '../src/checkout.ts';
import { displayName } from '../src/legacy.ts';

test('a checkout parses with string metadata', () => {
  const parsed = Checkout.parse({ id: 'c1', metadata: { source: 'web' } });
  assert.equal(parsed.metadata['source'], 'web');
});

test('an empty display name falls back', () => {
  assert.equal(displayName(''), 'anonymous');
});
