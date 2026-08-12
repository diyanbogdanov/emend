import test from 'node:test';
import assert from 'node:assert/strict';
import { orderTotal } from '../src/total.ts';

test('an empty basket totals zero rather than NaN', () => {
  assert.equal(orderTotal([]), 0);
  assert.equal(orderTotal([{ id: 'a', total: 12.5 }, { id: 'b', total: 7.5 }]), 20);
});
