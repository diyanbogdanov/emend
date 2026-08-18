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

import { compareVersions } from './versions.ts';

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
  /** `paths` is why each parent is being bumped: its route down to `child`. */
  | { kind: 'parent'; child: string; parents: string[]; paths: string[][]; to: string }
  | { kind: 'none'; reason: string };

/**
 * The route from each of the repository's own dependencies down to this package.
 *
 * A breadth-first walk from each direct dependency through the lockfile's
 * dependency maps. Cycles are ordinary — two packages depending on each other
 * is legal and not rare — so visited nodes are tracked.
 *
 * The walk always knew the route and used to discard it, keeping only which
 * direct dependency to bump. That left the first question a reviewer asks of a
 * transitive advisory unanswered: `express` is being bumped for a CVE in `qs`,
 * and nothing said why those two are related. The route is the answer, and it
 * costs a predecessor map over a walk that was happening anyway.
 */
export function pathsTo(lockRaw: string, child: string, directs: Set<string>): string[][] {
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

  const routes: string[][] = [];
  for (const direct of directs) {
    // A direct dependency is its own route. Rung one still has to answer "why is
    // this here", and the answer is that the repository asked for it.
    if (direct === child) {
      routes.push([direct]);
      continue;
    }
    // Breadth-first with a predecessor map, so the route that comes back is the
    // shortest one. A real tree reaches a popular package many ways, and listing
    // every route means listing a combinatorial number of them; the shortest is
    // the one that explains the dependency most directly.
    const cameFrom = new Map<string, string>();
    const seen = new Set<string>([direct]);
    const queue = [...depsOf(direct)];
    for (const dep of queue) cameFrom.set(dep, direct);

    let found = false;
    while (queue.length > 0 && !found) {
      const next = queue.shift() as string;
      if (next === child) {
        found = true;
        break;
      }
      if (seen.has(next)) continue;
      seen.add(next);
      for (const dep of depsOf(next)) {
        if (!cameFrom.has(dep)) cameFrom.set(dep, next);
        queue.push(dep);
      }
    }
    if (!found) continue;

    const route = [child];
    for (let at = cameFrom.get(child); at !== undefined; at = cameFrom.get(at)) {
      route.unshift(at);
      if (at === direct) break;
    }
    routes.push(route);
  }
  return routes;
}

/**
 * Which direct dependencies to bump — the first step of each route.
 *
 * Derived rather than computed separately, because two walks over the same tree
 * answering two halves of one question is how they come to disagree.
 */
export function dependentsOf(lockRaw: string, child: string, directs: Set<string>): string[] {
  return pathsTo(lockRaw, child, directs)
    .map((route) => route[0])
    .filter((name): name is string => name !== undefined && name !== child);
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

  const paths = pathsTo(lockRaw, vulnerable.name, directs);
  const parents = paths
    .map((route) => route[0])
    .filter((name): name is string => name !== undefined);
  if (parents.length === 0) {
    // Rung three — an override — is the answer here, and it is a separate
    // decision because it forces a version on a parent that asked for another.
    return {
      kind: 'none',
      reason: `no direct dependency's tree reaches ${vulnerable.name}, so nothing can be bumped to move it`,
    };
  }
  return { kind: 'parent', child: vulnerable.name, parents, paths, to: vulnerable.target };
}

/**
 * Force a version the dependency tree did not choose.
 *
 * The last rung, and the dangerous one. An override tells npm to resolve a
 * package at a version its parent did not ask for, and the parent may genuinely
 * break — that is what verification is for, and an override that does not verify
 * must be reported as unfixable rather than shipped.
 *
 * An existing `overrides` block is added to, never replaced: somebody put those
 * entries there deliberately and this tool knows nothing about why. A package
 * already pinned there is left alone entirely, rather than this arguing with a
 * human or with its own previous run.
 *
 * Returns an edit whose `find` is the whole manifest, so `applyTextEdits`
 * refuses it if the file has moved underneath — the same contract every other
 * repair here uses.
 */
export function planOverride(
  manifestRaw: string,
  pkg: string,
  version: string,
): { file: string; find: string; replace: string; reason: string } | null {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof manifest !== 'object' || manifest === null) return null;

  const existing =
    typeof manifest['overrides'] === 'object' && manifest['overrides'] !== null
      ? (manifest['overrides'] as Record<string, unknown>)
      : {};
  if (existing[pkg] === version) return null;

  const updated = { ...manifest, overrides: { ...existing, [pkg]: version } };
  return {
    file: 'package.json',
    find: manifestRaw,
    // Two spaces and a trailing newline: what npm itself writes, so the diff is
    // the override and not a reformatting of the whole manifest.
    replace: `${JSON.stringify(updated, null, 2)}\n`,
    reason: `force ${pkg} to ${version}, which no dependency's own range selects`,
  };
}

export interface FixedRecord {
  pkg: string;
  /** The version that cleared it, recorded when the fix verified. */
  fixedAt: string;
  advisories: string[];
}

export interface Reintroduction extends FixedRecord {
  was: string;
  now: string;
}

/**
 * Packages that were fixed once and have slipped back.
 *
 * A revert, a bad merge, a lockfile regenerated from a stale branch. Without
 * this it arrives looking like a brand-new finding, and the fact that it was
 * already dealt with — and by which change — is lost.
 *
 * A package that is simply gone is not a reintroduction. Removing a dependency
 * is a fix.
 */
export function reintroduced(
  fixed: FixedRecord[],
  installed: Map<string, string>,
): Reintroduction[] {
  const back: Reintroduction[] = [];
  for (const record of fixed) {
    const now = installed.get(record.pkg);
    if (now === undefined) continue;
    if (compareVersions(now, record.fixedAt) < 0) {
      back.push({ ...record, was: record.fixedAt, now });
    }
  }
  return back;
}
