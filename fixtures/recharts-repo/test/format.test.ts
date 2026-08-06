import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRevenue, totalCents, type Slice } from '../src/format.ts';

const data: Slice[] = [
  { id: 'a', label: 'Subscriptions', revenueCents: 125000, colour: '#4c6ef5' },
  { id: 'b', label: 'Services', revenueCents: 34050, colour: '#12b886' },
];

test('cents are rendered as whole currency units', () => {
  assert.equal(formatRevenue(125000), '$1250.00');
  assert.equal(formatRevenue(34050), '$340.50');
});

test('a real zero is rendered as zero', () => {
  // The distinction that matters if a migration ever coerces a missing value:
  // a fabricated zero and a measured zero look identical on the chart.
  assert.equal(formatRevenue(0), '$0.00');
});

test('the total is the sum of every slice', () => {
  assert.equal(totalCents(data), 159050);
});
