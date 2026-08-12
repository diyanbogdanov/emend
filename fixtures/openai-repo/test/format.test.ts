import test from 'node:test';
import assert from 'node:assert/strict';
import { summarise } from '../src/format.ts';

test('a routed ticket reads as its queue and subject', () => {
  assert.equal(summarise('  Card declined  ', 'billing'), '[billing] Card declined');
});
