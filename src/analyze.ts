/**
 * The scan pipeline: inventory -> surface diff -> call-site intersection.
 *
 * The intersection is the product. A diff on its own is a wall of noise; call
 * sites on their own are just a symbol index. Crossing them yields findings that
 * a human can act on without reading a changelog.
 */

import { createHash } from 'node:crypto';
import { readRepo } from './inventory.ts';
import {
  fetchPackument,
  fetchPackageDir,
  resolveTargetVersion,
  compareVersions,
} from './registry.ts';
import { extractSurface } from './surface.ts';
import { diffSurfaces, consumerImpacting } from './diff.ts';
import { findCallSites } from './callsites.ts';
import { materializeRepoDeps } from './vendor.ts';
import type {
  ApiSurface,
  Finding,
  PackageReport,
  ScanReport,
  SurfaceChange,
} from './types.ts';

export interface ScanOptions {
  /** Restrict analysis to these package names. */
  only?: string[];
  /** Include devDependencies. Default true. */
  includeDev?: boolean;
  /** Max packages to analyze before warning and stopping. Default 120. */
  maxPackages?: number;
  /** Progress callback for CLI output. */
  onProgress?: (message: string) => void;
  /**
   * Stable identity for the repository, used to correlate findings across
   * scans. Defaults to the directory, which is right for a local checkout but
   * wrong for a hosted scan: those unpack into a fresh temp directory each time,
   * so a path-based key would make every finding look new on every run.
   * Hosted scans pass `github.com/<owner>/<repo>`.
   */
  repoKey?: string;
  /**
   * Stage dependencies from the registry cache when `node_modules` is absent.
   *
   * Off by default because it writes into the repository directory, which is
   * unwelcome in someone's working checkout. Hosted scans operate on a
   * throwaway extraction and always enable it — without it they resolve types
   * poorly and find roughly half the call sites the CLI does.
   */
  vendorDeps?: boolean;
}

export function findingId(
  pkg: string,
  from: string,
  to: string,
  change: SurfaceChange,
): string {
  return createHash('sha256')
    .update(`${pkg}|${from}|${to}|${change.path}|${change.kind}`)
    .digest('hex')
    .slice(0, 12);
}

/** Run async work with bounded concurrency; ordering of results is preserved. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await fn(item, index);
    }
  });
  await Promise.all(workers);
  return results;
}

interface Analyzed {
  report: PackageReport;
  surface?: ApiSurface;
  impacting?: SurfaceChange[];
}

export async function scanRepo(
  repoDir: string,
  options: ScanOptions = {},
): Promise<ScanReport> {
  const startedAt = new Date().toISOString();
  const progress = options.onProgress ?? (() => {});
  // Raised for workspace repositories: a private monorepo declares 60 across six
  // manifests, and a cap of 40 would have truncated a third of them behind a
  // warning nobody reads. Scans are roughly a second per package once the
  // tarball cache is warm, so the ceiling can afford to be generous.
  const maxPackages = options.maxPackages ?? 120;

  const repo = await readRepo(repoDir);
  const warnings = [...repo.warnings];

  // Stage dependencies before building the TypeScript program. Type-based call
  // site matching resolves `octokit.rest.repos.get` through the checker, which
  // needs the real declarations on disk; without them it silently falls back to
  // import-based matching alone and misses most nested-resource usage.
  if (options.vendorDeps) {
    const staged = await materializeRepoDeps(repoDir, repo.dependencies, progress);
    if (staged.failed.length > 0) {
      warnings.push(
        `${staged.failed.length} dependency package(s) could not be staged (${staged.failed
          .slice(0, 5)
          .map((f) => f.pkg)
          .join(', ')}${staged.failed.length > 5 ? ', …' : ''}) — call sites in code that imports them may be missed`,
      );
    }
  }

  let deps = repo.dependencies.filter((d) => d.installed !== null);
  if (options.includeDev === false) deps = deps.filter((d) => !d.dev);
  if (options.only && options.only.length > 0) {
    const wantedNames = new Set(options.only);
    deps = deps.filter((d) => wantedNames.has(d.name));
  }
  if (deps.length > maxPackages) {
    warnings.push(
      `${deps.length} dependencies present; analyzing the first ${maxPackages}. Remaining packages were NOT analyzed and are not known to be clean. Use --only to target specific packages.`,
    );
    deps = deps.slice(0, maxPackages);
  }

  progress(`analyzing ${deps.length} package(s)`);

  // Stage 1: fetch and diff each package's surface. Bounded concurrency keeps
  // this network-bound rather than serialised, without hammering the registry.
  const analyzed = await mapLimit(deps, 4, async (dep): Promise<Analyzed> => {
    const from = dep.installed;
    if (!from) {
      return {
        report: {
          pkg: dep.name,
          status: 'error',
          fromVersion: null,
          toVersion: null,
          findings: [],
          unlocatedBreaking: 0,
          note: 'no installed version could be resolved',
        },
      };
    }

    try {
      const packument = await fetchPackument(dep.name);
      const to = resolveTargetVersion(packument);
      if (!to) {
        return {
          report: {
            pkg: dep.name,
            status: 'error',
            fromVersion: from,
            toVersion: null,
            findings: [],
            unlocatedBreaking: 0,
            note: 'registry published no resolvable latest version',
          },
        };
      }
      if (compareVersions(to, from) <= 0) {
        return {
          report: {
            pkg: dep.name,
            status: 'up-to-date',
            fromVersion: from,
            toVersion: to,
            findings: [],
            unlocatedBreaking: 0,
            note: `installed ${from} is at or ahead of latest ${to}`,
          },
        };
      }

      progress(`  ${dep.name}: ${from} -> ${to}`);

      const [fromDir, toDir] = await Promise.all([
        fetchPackageDir(dep.name, from),
        fetchPackageDir(dep.name, to),
      ]);
      const [fromSurface, toSurface] = await Promise.all([
        extractSurface(fromDir, dep.name, from),
        extractSurface(toDir, dep.name, to),
      ]);

      const diff = diffSurfaces(fromSurface, toSurface);
      if (diff.unanalyzable) {
        return {
          report: {
            pkg: dep.name,
            status: 'unanalyzable',
            fromVersion: from,
            toVersion: to,
            findings: [],
            unlocatedBreaking: 0,
            note: diff.note ?? 'no type declarations to compare',
          },
        };
      }

      const impacting = consumerImpacting(diff);
      return {
        report: {
          pkg: dep.name,
          status: 'analyzed',
          fromVersion: from,
          toVersion: to,
          findings: [],
          unlocatedBreaking: 0,
          ...(diff.note ? { note: diff.note } : {}),
        },
        // The OLD surface is what call sites are written against — matching must
        // use the names that exist in the code today, not the ones in the upgrade.
        surface: fromSurface,
        impacting,
      };
    } catch (err) {
      return {
        report: {
          pkg: dep.name,
          status: 'error',
          fromVersion: from,
          toVersion: null,
          findings: [],
          unlocatedBreaking: 0,
          note: (err as Error).message,
        },
      };
    }
  });

  // Stage 2: one TypeScript program over the repo, resolving every package at once.
  const surfaces = new Map<string, ApiSurface>();
  const wanted = new Map<string, Set<string>>();
  for (const a of analyzed) {
    if (a.surface && a.impacting && a.impacting.length > 0) {
      surfaces.set(a.report.pkg, a.surface);
      wanted.set(a.report.pkg, new Set(a.impacting.map((c) => c.path)));
    }
  }

  let callSiteCount = 0;
  if (surfaces.size > 0) {
    progress(`locating call sites across ${surfaces.size} package(s)`);
    const index = findCallSites(repoDir, surfaces, wanted);
    warnings.push(...index.warnings);
    progress(`  analyzed ${index.filesAnalyzed} source file(s)`);

    for (const a of analyzed) {
      if (!a.impacting) continue;
      const bucket = index.byPackage.get(a.report.pkg);
      if (!bucket) continue;

      const findings: Finding[] = [];
      let unlocated = 0;
      for (const change of a.impacting) {
        const sites = bucket.get(change.path);
        if (!sites || sites.length === 0) {
          unlocated++;
          continue;
        }
        callSiteCount += sites.length;
        findings.push({
          id: findingId(a.report.pkg, a.report.fromVersion ?? '', a.report.toVersion ?? '', change),
          pkg: a.report.pkg,
          fromVersion: a.report.fromVersion ?? '',
          toVersion: a.report.toVersion ?? '',
          change,
          sites,
          confidence: change.confidence,
        });
      }
      a.report.findings = findings;
      a.report.unlocatedBreaking = unlocated;
    }
  } else {
    for (const a of analyzed) {
      if (a.impacting) a.report.unlocatedBreaking = a.impacting.length;
    }
  }

  const packages = analyzed.map((a) => a.report);
  const breaking = packages
    .flatMap((p) => p.findings)
    .filter((f) => f.change.severity === 'breaking').length;
  const deprecation = packages
    .flatMap((p) => p.findings)
    .filter((f) => f.change.severity === 'deprecation').length;

  return {
    repo: options.repoKey ?? repoDir,
    startedAt,
    finishedAt: new Date().toISOString(),
    packages,
    warnings,
    counts: {
      packagesAnalyzed: packages.filter((p) => p.status === 'analyzed').length,
      packagesSkipped: packages.filter((p) => p.status !== 'analyzed').length,
      breaking,
      deprecation,
      callSites: callSiteCount,
    },
  };
}
