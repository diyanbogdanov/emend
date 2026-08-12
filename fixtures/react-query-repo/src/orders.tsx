import { useQuery } from '@tanstack/react-query';

export interface Order {
  id: string;
  total: number;
}

async function fetchOrders(): Promise<Order[]> {
  const res = await fetch('/api/orders');
  return res.json() as Promise<Order[]>;
}

/**
 * v4's three-argument form. All three of these break in v5, and none of them is
 * a rename the caller can guess: the positional signature becomes a single
 * object, `cacheTime` becomes `gcTime`, and `isLoading` becomes `isPending`
 * while a *different* `isLoading` survives with a narrower meaning — which is
 * the one that bites, because the wrong fix still compiles.
 */
export function useOrders() {
  const { data, isLoading, error } = useQuery(['orders'], fetchOrders, {
    cacheTime: 5 * 60 * 1000,
    staleTime: 30 * 1000,
  });
  return { orders: data ?? [], loading: isLoading, error };
}
