import { z } from 'zod';
import { LineItemSchema } from './schema.ts';

export const CurrencySchema = z.enum(['USD', 'EUR', 'GBP']);

export const PriceQuoteSchema = z.object({
  currency: CurrencySchema,
  subtotalCents: z.number().int().nonnegative(),
  taxCents: z.number().int().nonnegative(),
  totalCents: z.number().int().nonnegative(),
});

export type PriceQuote = z.infer<typeof PriceQuoteSchema>;
export type LineItem = z.infer<typeof LineItemSchema>;

const TAX_RATE = 0.2;

export function quote(items: LineItem[], currency: 'USD' | 'EUR' | 'GBP'): PriceQuote {
  const subtotalCents = items.reduce(
    (sum, item) => sum + item.quantity * item.unitPriceCents,
    0,
  );
  const taxCents = Math.round(subtotalCents * TAX_RATE);
  return PriceQuoteSchema.parse({
    currency,
    subtotalCents,
    taxCents,
    totalCents: subtotalCents + taxCents,
  });
}
