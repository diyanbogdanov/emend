import { z } from 'zod';

/**
 * Validation schemas for the checkout service.
 *
 * Written against zod 3.x. Several of the APIs used here changed in zod 4 —
 * which is exactly what Emend should detect and localise.
 */

export const CustomerSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string().min(1).max(200),
  createdAt: z.string().datetime(),
});

export const LineItemSchema = z.object({
  sku: z.string(),
  quantity: z.number().int().positive(),
  unitPriceCents: z.number().int().nonnegative(),
});

export const CheckoutSchema = z
  .object({
    customer: CustomerSchema,
    items: z.array(LineItemSchema).min(1),
    couponCode: z.string().optional(),
    metadata: z.record(z.string()),
  })
  .strict();

export type Checkout = z.infer<typeof CheckoutSchema>;

export function parseCheckout(input: unknown): Checkout {
  return CheckoutSchema.parse(input);
}

export function describeFailure(input: unknown): string[] {
  const result = CheckoutSchema.safeParse(input);
  if (result.success) return [];
  return result.error.errors.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}
