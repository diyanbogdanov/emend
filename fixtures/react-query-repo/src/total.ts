import type { Order } from './orders.tsx';

/** Pure, and the only thing the tests exercise. Unaffected by the upgrade. */
export function orderTotal(orders: Order[]): number {
  return orders.reduce((sum, o) => sum + o.total, 0);
}
