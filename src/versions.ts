/**
 * How an ecosystem orders its versions.
 *
 * npm is semver. PyPI is PEP 440, where `1.0.post1` outranks `1.0` and an epoch
 * (`1!2.0`) outranks everything without one. `osv.ts` decides whether an
 * installed version sits below the advisory's fixed version by calling this, so
 * a scheme that is wrong reports vulnerabilities that do not exist and hides
 * ones that do — in that order of visibility, which is the worse way round.
 *
 * The fallback is semver, so that removing this seam's only implementation
 * cannot change behaviour. That fallback is also a trap for whoever adds PyPI:
 * **register the PEP 440 scheme before the PyPI inventory ships**, or Python
 * versions will be compared as semver and quietly mis-ranked.
 */

/** One ecosystem's answer to "which of these two versions is newer". */
export interface VersionScheme {
  id: string;
  handles(ecosystem: string): boolean;
  /**
   * `<0` if `a` sorts before `b`, `0` if they are equivalent, `>0` if `a`
   * sorts after `b` — the standard comparator contract. `osv.ts` reads the
   * sign itself at six call sites, not just which side is bigger, so every
   * implementation of this must honour it exactly. A prerelease sorts below
   * the release it precedes.
   */
  compare(a: string, b: string): number;
  /** Whether `version` is a prerelease under this scheme. */
  isPrerelease(version: string): boolean;
}

function semverScheme(): VersionScheme {
  return {
    id: 'semver',
    handles: () => true,
    compare(a, b) {
      // Docker tags are often written `v18`, and `parseInt('v1')` is NaN —
      // which fell through to 0, so every major version compared as zero and
      // `v2.0.0` equalled `v1.0.0`.
      const [aCore = '', aPre = ''] = a.replace(/^v/, '').split('-', 2);
      const [bCore = '', bPre = ''] = b.replace(/^v/, '').split('-', 2);
      const aParts = aCore.split('.').map((n) => Number.parseInt(n, 10) || 0);
      const bParts = bCore.split('.').map((n) => Number.parseInt(n, 10) || 0);
      for (let i = 0; i < 3; i++) {
        const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
        if (diff !== 0) return diff;
      }
      if (aPre === bPre) return 0;
      if (aPre === '') return 1; // release > prerelease
      if (bPre === '') return -1;
      return aPre < bPre ? -1 : 1;
    },
    isPrerelease: (v) => v.includes('-'),
  };
}

/**
 * The scheme every ecosystem falls back to. Exported so tests can compose a
 * registry.
 *
 * Returns a fresh instance, not the one inside `SCHEMES`: nothing on
 * `VersionScheme` is `readonly`, so handing out the shared instance would let
 * a test's mutation corrupt production's copy of it.
 */
export function semverFloor(): VersionScheme {
  return semverScheme();
}

// Ordered: the first scheme that claims an ecosystem wins, and semver claims
// everything, so it must stay last. A new scheme goes before it in this array
// — skip that and its ecosystem quietly compares as semver instead (see the
// module doc above for what that costs PyPI).
const SCHEMES: VersionScheme[] = [semverScheme()];

/**
 * The scheme for this ecosystem.
 *
 * The default registry always answers, because semver claims every
 * ecosystem. A caller-supplied registry with no catch-all floor throws
 * instead of guessing.
 *
 * The registry is a parameter so the routing can be tested through this
 * function rather than around it.
 */
export function schemeFor(
  ecosystem: string,
  registry: VersionScheme[] = SCHEMES,
): VersionScheme {
  const found = registry.find((s) => s.handles(ecosystem));
  if (found) return found;
  // Reached only by a registry with no catch-all floor. Guessing an order for
  // an unknown ecosystem is exactly how versions get silently mis-ranked, which
  // is what this seam exists to prevent — so it is said rather than assumed.
  throw new Error(`no version scheme claims ecosystem '${ecosystem}'`);
}

/**
 * npm-default convenience, so callers without an ecosystem in hand are
 * unchanged. Current callers: `registry.ts`, `fix.ts`, `remediate.ts`,
 * `analyze.ts`, `scripts/audit-removals.ts` — all genuinely npm-only today.
 * A caller that learns a second ecosystem must switch to
 * `schemeFor(ecosystem).compare` rather than keep calling this under the same
 * name; that is exactly how the bug this seam exists to prevent comes back.
 */
export function compareVersions(a: string, b: string): number {
  return schemeFor('npm').compare(a, b);
}

/**
 * npm-default convenience; only `registry.ts` calls this today, to filter
 * prereleases out of `resolveTargetVersion` and `resolveRange`. The same
 * warning as `compareVersions` applies: a caller that learns a second
 * ecosystem must switch to `schemeFor(ecosystem).isPrerelease`.
 */
export function isPrerelease(version: string): boolean {
  return schemeFor('npm').isPrerelease(version);
}
