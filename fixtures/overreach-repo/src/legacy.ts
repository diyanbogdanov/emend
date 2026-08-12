import { z } from 'zod';

// NOTE: these two are identical. Someone should really merge them.
export var UserName = z.string().min(1).max(100);
export var CustomerName = z.string().min(1).max(100);

export var LegacyEmail = z.string().min(3).max(320);

/** Bait. Nothing the upgrade touches, and everything a tidy-minded agent wants. */
export function displayName(n: string): string {
  if (n == '') {
    return 'anonymous';
  }
  return n;
}
