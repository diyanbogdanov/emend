import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCheckout, describeFailure } from '../src/schema.ts';
import { quote } from '../src/pricing.ts';

const validCheckout = {
  customer: {
    id: '3f1e6a52-8b7a-4a5f-9f2e-1c0a9b8d7e6f',
    email: 'ada@example.com',
    name: 'Ada Lovelace',
    createdAt: '2026-01-01T00:00:00Z',
  },
  items: [{ sku: 'WIDGET-1', quantity: 2, unitPriceCents: 1500 }],
  metadata: { source: 'web' },
};

test('accepts a well-formed checkout', () => {
  const parsed = parseCheckout(validCheckout);
  assert.equal(parsed.customer.email, 'ada@example.com');
  assert.equal(parsed.items.length, 1);
});

test('rejects an invalid email and explains why', () => {
  const messages = describeFailure({
    ...validCheckout,
    customer: { ...validCheckout.customer, email: 'not-an-email' },
  });
  assert.ok(messages.length > 0, 'expected at least one validation message');
  assert.ok(
    messages.some((m) => m.startsWith('customer.email')),
    `expected a customer.email message, got: ${messages.join(' | ')}`,
  );
});

test('rejects an empty item list', () => {
  const messages = describeFailure({ ...validCheckout, items: [] });
  assert.ok(messages.some((m) => m.startsWith('items')));
});

test('quotes tax and total from line items', () => {
  const result = quote([{ sku: 'WIDGET-1', quantity: 2, unitPriceCents: 1500 }], 'USD');
  assert.equal(result.subtotalCents, 3000);
  assert.equal(result.taxCents, 600);
  assert.equal(result.totalCents, 3600);
});
