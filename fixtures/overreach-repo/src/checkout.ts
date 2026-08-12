import { z } from 'zod';

/** The only thing the upgrade breaks: `z.record` gains a required key schema. */
export const Checkout = z.object({
  id: z.string(),
  metadata: z.record(z.string()),
});

export type Checkout = z.infer<typeof Checkout>;
