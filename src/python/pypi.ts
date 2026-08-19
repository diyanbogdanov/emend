/**
 * PyPI registry client: version metadata now, file extraction in a later task.
 *
 * `versions()` reads PyPI's JSON API (`GET /pypi/<name>/json`), which is pure
 * metadata — no package code runs to answer it. `fetch()` is the one that will
 * download and extract a package version (Task 8 of this plan), and when it
 * does it must prefer the wheel over the sdist, for the same reason
 * `lockfile.ts` gives for parsing manifests instead of running `npm install`:
 * running a customer repository's dependency code during analysis is arbitrary
 * code execution, and that is the one thing Emend does not do. An sdist can
 * need its `setup.py` executed just to report its own file list and metadata —
 * that execution is precisely what the no-execution rule forbids. A wheel is a
 * zip of files the maintainer already built; reading one open runs nothing.
 * `pip` itself is never invoked, the same reason `npm install` never is.
 */

import type { PackageVersions, RegistryClient } from '../registry.ts';

/** The slice of PyPI's JSON API response `toPackageVersions` reads. */
interface PyPIPackageDoc {
  info?: { version?: string | null };
  releases?: Record<string, unknown>;
}

/**
 * Maps PyPI's JSON API response onto the neutral `PackageVersions` shape.
 *
 * Exported so PyPI's JSON shape can be tested without a network call.
 */
export function toPackageVersions(doc: PyPIPackageDoc, name: string): PackageVersions {
  return {
    name,
    versions: Object.keys(doc.releases ?? {}),
    latest: doc.info?.version ?? null,
  };
}

export function pypiClient(): RegistryClient {
  return {
    id: 'pypi',
    handles: (ecosystem) => ecosystem === 'PyPI',

    async versions(pkg) {
      const url = `https://pypi.org/pypi/${pkg}/json`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`PyPI ${res.status} for ${pkg} (${url})`);
      }
      return toPackageVersions((await res.json()) as PyPIPackageDoc, pkg);
    },

    // Deliberately throws rather than returning an empty directory. An empty
    // directory would extract as a package with no public API, which diffs
    // against any real version as "nothing changed" — a seam must never invent
    // an answer, and "no public API" is exactly that: an answer nobody read.
    // Task 8 of this plan implements real extraction, wheel-first (module doc).
    async fetch(pkg, version) {
      throw new Error(
        `downloading PyPI packages is not implemented yet (${pkg}@${version}); ` +
          'surface extraction lands in a later task of this plan',
      );
    },
  };
}
