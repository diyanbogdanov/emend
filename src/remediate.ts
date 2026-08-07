/**
 * Working out what to bump so a vulnerable package stops being installed.
 *
 * Most vulnerabilities in a real tree are transitive: the repository never
 * listed the package and cannot bump it. What it *can* bump is whichever
 * dependency it did list that drags the vulnerable one in — so the question is
 * which direct dependency's subtree reaches it.
 *
 * npm hoists, which is what makes this awkward. `qs` sits at `node_modules/qs`
 * however deep the thing that needs it is, so the install path names no parent
 * and reading one out of it would report almost every real transitive
 * vulnerability as unfixable. The `dependencies` map on each lockfile entry is
 * the actual graph, and this walks it.
 *
 * Nothing here predicts what a bump will resolve. It names a bump to try; the
 * pipeline installs it and re-reads the lockfile to find out whether the child
 * actually moved. Predicting semver resolution is a worse job than doing it.
 */

interface LockPackages {
  packages?: Record<string, { version?: unknown; dependencies?: Record<string, unknown> }>;
}

export interface VulnerableTarget {
  name: string;
  version: string;
  /** The version that clears every advisory, or null when none is published. */
  target: string | null;
}

export type Remediation =
  | { kind: 'direct'; pkg: string; to: string }
  | { kind: 'parent'; child: string; parents: string[]; to: string }
  | { kind: 'none'; reason: string };

/**
 * Which of the repository's own dependencies lead to this package.
 *
 * A breadth-first walk from each direct dependency through the lockfile's
 * dependency maps. Cycles are ordinary — two packages depending on each other
 * is legal and not rare — so visited nodes are tracked.
 */
export function dependentsOf(lockRaw: string, child: string, directs: Set<string>): string[] {
  let lock: LockPackages;
  try {
    lock = JSON.parse(lockRaw) as LockPackages;
  } catch {
    return [];
  }
  const packages = lock.packages;
  if (typeof packages !== 'object' || packages === null) return [];

  // Hoisted or nested, a package's dependencies are keyed the same way.
  const depsOf = (name: string): string[] => {
    const entry =
      packages[`node_modules/${name}`] ??
      Object.entries(packages).find(([p]) => p.endsWith(`/node_modules/${name}`))?.[1];
    return Object.keys(entry?.dependencies ?? {});
  };

  const reaching: string[] = [];
  for (const direct of directs) {
    if (direct === child) continue;
    const seen = new Set<string>([direct]);
    const queue = depsOf(direct);
    let found = false;
    while (queue.length > 0 && !found) {
      const next = queue.shift() as string;
      if (next === child) {
        found = true;
        break;
      }
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...depsOf(next));
    }
    if (found) reaching.push(direct);
  }
  return reaching;
}

/**
 * The bump to try for one vulnerable package.
 *
 * Rung one is a direct dependency: bump it. Rung two is a transitive one: bump
 * whichever direct dependencies drag it in, and let the install decide whether
 * that was enough. Anything else earns no plan — an unfixable vulnerability is
 * a real answer, and proposing a bump to a version that does not exist is not a
 * smaller failure than proposing none.
 */
export function planRemediation(
  vulnerable: VulnerableTarget,
  directs: Set<string>,
  lockRaw: string,
): Remediation {
  if (vulnerable.target === null) {
    return { kind: 'none', reason: `${vulnerable.name} has no published fix` };
  }
  if (directs.has(vulnerable.name)) {
    return { kind: 'direct', pkg: vulnerable.name, to: vulnerable.target };
  }

  const parents = dependentsOf(lockRaw, vulnerable.name, directs);
  if (parents.length === 0) {
    // Rung three — an override — is the answer here, and it is a separate
    // decision because it forces a version on a parent that asked for another.
    return {
      kind: 'none',
      reason: `no direct dependency's tree reaches ${vulnerable.name}, so nothing can be bumped to move it`,
    };
  }
  return { kind: 'parent', child: vulnerable.name, parents, to: vulnerable.target };
}
