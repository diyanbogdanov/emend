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
  compare(a: string, b: string): number;
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

/** The scheme every ecosystem falls back to. Exported so tests can compose a registry. */
export function semverFloor(): VersionScheme {
  return semverScheme();
}

// Ordered: the first scheme that claims an ecosystem wins, and semver claims
// everything, so it must stay last.
const SCHEMES: VersionScheme[] = [semverScheme()];

/**
 * The scheme for this ecosystem. Never undefined — semver is the floor.
 *
 * The registry is a parameter so the routing can be tested through this
 * function rather than around it.
 */
export function schemeFor(
  ecosystem: string,
  registry: VersionScheme[] = SCHEMES,
): VersionScheme {
  return registry.find((s) => s.handles(ecosystem)) ?? registry[registry.length - 1]!;
}

/** npm-default convenience, so callers without an ecosystem in hand are unchanged. */
export function compareVersions(a: string, b: string): number {
  return schemeFor('npm').compare(a, b);
}

export function isPrerelease(version: string): boolean {
  return schemeFor('npm').isPrerelease(version);
}
