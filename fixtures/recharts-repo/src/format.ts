/**
 * Presentation helpers for the revenue chart.
 *
 * Kept out of the component file so they can be tested directly: Node's type
 * stripping runs TypeScript but not JSX, so anything the test suite imports has
 * to be free of it.
 */

export interface Slice {
  id: string;
  label: string;
  revenueCents: number;
  colour: string;
}

/**
 * Money arrives in cents and is displayed in whole currency units.
 *
 * A fabricated zero is indistinguishable from a real measurement of zero on a
 * chart a customer acts on, so a missing value must never become `0`.
 */
export function formatRevenue(value: number): string {
  return `$${(value / 100).toFixed(2)}`;
}

/** Total revenue across every slice, in cents. */
export function totalCents(data: Slice[]): number {
  return data.reduce((sum, slice) => sum + slice.revenueCents, 0);
}
