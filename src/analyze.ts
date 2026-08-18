/**
 * The scan pipeline: inventory -> surface diff -> call-site intersection.
 *
 * The intersection is the product. A diff on its own is a wall of noise; call
 * sites on their own are just a symbol index. Crossing them yields findings that
 * a human can act on without reading a changelog.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readRepo } from './inventory.ts';
import { freshnessFindings } from './freshness.ts';
import { featureFindings, newExports } from './features.ts';
import { scanPins, resolvedVersions } from './pins.ts';
import {
  detectorsFor,
  groupByDetector,
  runDetectors,
  type HttpContractOptions,
  type VulnerabilityOptions,
  type ExternalLintOptions,
} from './detectors.ts';
import { walkDir } from './callsites.ts';
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
  ApiSymbol,
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
  /**
   * Stop after this many packages. Unlimited by default.
   *
   * A cap trades findings for latency, and that is the wrong trade for this
   * product: a package that was not analysed is reported as such, but a warning
   * is weaker evidence than a finding and readers discount it. Callers that
   * genuinely need a bound — an interactive command, a smoke test — can set one.
   */
  maxPackages?: number;
  /**
   * Check outbound HTTP calls against their vendor's published description.
   *
   * Off unless a resolver is supplied, because this is the only part of a scan
   * that reaches the network — enabling it means choosing to make outbound
   * requests to every host in the source tree.
   */
  contracts?: HttpContractOptions;
  /**
   * Check the installed tree against a vulnerability database.
   *
   * Off unless a scanner is supplied, for the same reason contracts are: it
   * reaches the network, and that is the caller's decision to make.
   */
  vulnerabilities?: VulnerabilityOptions;
  /**
   * Report packages that are simply behind, where nothing this repository calls
   * changed. Off by default: they are unbounded, and the spec keeps them out of
   * the way of proven findings.
   */
  freshness?: boolean;
  /**
   * Migrate named packages to a fixed version instead of the registry's latest.
   *
   * For callers that need the same migration twice. The benchmark is the one
   * that does: every case names a target in its id, and resolving `latest`
   * instead meant `openai-3.3.0-to-4.104.0` was running 3.3.0 -> 7.4.0 and being
   * scored against a denominator counted for 3 -> 4.
   *
   * Not a general "downgrade" switch: an ordinary scan wants the latest, and
   * anything else is the caller declaring it has a reason.
   */
  targets?: Record<string, string>;
  /**
   * Report new top-level exports in packages this repository depends on.
   *
   * Off by default for freshness's reason, which applies harder here: every
   * upgrade adds something, and nothing in the repository is affected either
   * way.
   */
  features?: boolean;
  /** Run external linters over Dockerfiles and shell scripts. */
  lint?: ExternalLintOptions;
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

/** Same shape, same keys, no signature strings. */
function withoutSignatures(surface: ApiSurface): ApiSurface {
  const symbols: Record<string, ApiSymbol> = {};
  for (const [path, sym] of Object.entries(surface.symbols)) {
    symbols[path] = { ...sym, signature: '' };
  }
  return { ...surface, symbols };
}

interface Analyzed {
  report: PackageReport;
  surface?: ApiSurface;
  impacting?: SurfaceChange[];
  /**
   * New top-level exports, already narrowed. Absent unless asked for, so the
   * default scan carries none of it.
   */
  features?: SurfaceChange[];
}

export async function scanRepo(
  repoDir: string,
  options: ScanOptions = {},
): Promise<ScanReport> {
  const startedAt = new Date().toISOString();
  const progress = options.onProgress ?? (() => {});
  const maxPackages = options.maxPackages ?? Number.POSITIVE_INFINITY;

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
      `${deps.length} dependencies present; analyzing the first ${maxPackages} because a limit was set explicitly. The rest were NOT analyzed and are not known to be clean.`,
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
      const pinned = options.targets?.[dep.name];
      // A pin that was never published is a typo, and silently falling back to
      // `latest` would migrate somewhere the caller did not ask for while
      // reporting success. The benchmark would read that as the model
      // over-editing.
      if (pinned && !packument.versions?.[pinned]) {
        return {
          report: {
            pkg: dep.name,
            status: 'error',
            fromVersion: from,
            toVersion: null,
            findings: [],
            unlocatedBreaking: 0,
            note: `target ${pinned} was requested but the registry does not publish it`,
          },
        };
      }
      const to = pinned ?? resolveTargetVersion(packument);
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
        // Retained only for call-site matching, which needs symbol *existence*,
        // the alias map and the member index — never the signature text. Those
        // strings are most of a surface's memory (googleapis alone holds about
        // 3 GB of them), and every analysed package's surface stays live for the
        // whole scan, so keeping them would multiply the peak by the dependency
        // count for no benefit.
        surface: withoutSignatures(fromSurface),
        impacting,
        // Narrowed here rather than held whole, for the reason the surface
        // above is: what stays live for the rest of the scan should be what a
        // finding could actually use.
        ...(options.features ? { features: newExports(diff.changes) } : {}),
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
          detector: 'npm-surface',
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

  // Versions the repository copied out of its lockfile into places nothing keeps
  // honest. Independent of the surface diff: it needs no registry and no target
  // version, so it runs even for packages that were skipped as unanalyzable.
  // Source files carry wire-protocol pins — `apiVersion`, a version header —
  // which no declaration diff can see, because the vendor versions its protocol
  // separately from the package that calls it. Bounded: the same walk the call
  // site pass already does, minus its type checking.
  // Not only the TypeScript. A Dockerfile and a shell script are as much part
  // of "does this repository still work", and a detector cannot be offered files
  // the walk never collected — `--lint` silently found nothing until this list
  // included them. `walkDir` matches by suffix, so a bare `Dockerfile` is named
  // in full and `api.Dockerfile` matches the same entry.
  const walked = walkDir(repoDir, [
    '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
    '.sh', '.bash', 'Dockerfile', 'Containerfile',
  ]).map((f) => path.relative(repoDir, f));

  // No cap. It was four hundred, then ten thousand, and both were guesses at a
  // cost nobody had measured: reading all 19,333 files of n8n takes 3.5 seconds
  // and 109MB, and parsing them takes nine. A scan that already spends tens of
  // seconds on registry fetches can afford that — and the alternative was
  // asserting "not imported from this repository's source" after reading part
  // of it, which is the one kind of wrong answer this codebase exists to avoid.
  //
  // When there *was* a cap, it dropped by walk order: on n8n it hid 8 of 8
  // Dockerfiles and 7 of 9 shell scripts, and `--lint` read as clean. The
  // partition below survives from that era and now only orders the list.
  const configFiles = walked.filter((f) => /(Dockerfile|Containerfile)|\.(sh|bash)$/.test(f));
  const codeFiles = walked.filter((f) => !configFiles.includes(f));
  const sourceFiles = [...configFiles, ...codeFiles];
  const pinScan = await scanPins(
    resolvedVersions(repo.dependencies),
    async (file) => {
      try {
        return await readFile(path.join(repoDir, file), 'utf8');
      } catch {
        return null;
      }
    },
    sourceFiles,
  );
  const pinConflicts = pinScan.conflicts;

  // Everything downstream — the store, the dashboard, the pull request renderer
  // — consumes findings. A detector that produces anything else is invisible to
  // all of it, which is what kept pin drift out of every one of them.
  const detected = await runDetectors(
    detectorsFor({
      ...(options.contracts ? { contracts: options.contracts } : {}),
      ...(options.vulnerabilities ? { vulnerabilities: options.vulnerabilities } : {}),
      ...(options.lint ? { lint: options.lint } : {}),
    }),
    {
      repoDir,
      dependencies: repo.dependencies,
      sourceFiles,
      read: async (file) => {
        try {
          return await readFile(path.join(repoDir, file), 'utf8');
        } catch {
          return null;
        }
      },
    },
  );
  // Carried into the report rather than dropped: a host whose description was
  // located and not trusted is not a host that came back clean.
  warnings.push(...detected.notes);
  for (const failure of detected.failures) {
    // Never silent. A missing finding is indistinguishable from a clean result.
    warnings.push(`detector "${failure.detector}" failed: ${failure.reason}`);
  }
  for (const group of groupByDetector(detected.findings)) {
    packages.push({ ...group, status: 'analyzed', unlocatedBreaking: 0 });
  }

  // Its own group, before freshness, because a package that gained something is
  // still a package that broke nothing — and freshness reads `p.findings` to
  // decide that, so a feature finding pushed into a real package's group would
  // silently disqualify it from being reported as a free upgrade.
  if (options.features) {
    const gained = featureFindings(
      analyzed.flatMap((a) =>
        a.features && a.report.fromVersion && a.report.toVersion
          ? [{
              pkg: a.report.pkg,
              fromVersion: a.report.fromVersion,
              toVersion: a.report.toVersion,
              added: a.features,
            }]
          : [],
      ),
    );
    if (gained.length > 0) {
      packages.push({
        pkg: 'new since your version',
        status: 'analyzed',
        fromVersion: null,
        toVersion: null,
        findings: gained,
        unlocatedBreaking: 0,
      });
    }
  }

  // Last, and in its own group: a freshness finding says nothing this
  // repository calls changed, so it can only be computed once every package has
  // been analysed and every other detector has had its say.
  if (options.freshness) {
    const fresh = freshnessFindings(packages);
    if (fresh.length > 0) {
      packages.push({
        pkg: 'behind latest',
        status: 'analyzed',
        fromVersion: null,
        toVersion: null,
        findings: fresh,
        unlocatedBreaking: 0,
      });
    }
  }

  // Derived here rather than before the detectors ran. A contract finding is
  // `breaking`, and counting only the packages would have left it out of the one
  // line of a scan anybody reads.
  //
  // Every class is counted separately; which counts reach the `N breaking · M
  // deprecated` headline is the renderer's decision, and `inHeadline` in
  // freshness.ts writes that rule down. Keep the two in agreement when adding a
  // severity — a new class stays out of the headline by default.
  const allFindings = packages.flatMap((p) => p.findings);
  const breaking = allFindings.filter((f) => f.change.severity === 'breaking').length;
  const deprecation = allFindings.filter((f) => f.change.severity === 'deprecation').length;
  const vulnerabilities = allFindings.filter((f) => f.change.severity === 'vulnerability').length;
  const lint = allFindings.filter((f) => f.change.severity === 'lint').length;
  const freshness = allFindings.filter((f) => f.change.severity === 'freshness').length;
  const features = allFindings.filter((f) => f.change.severity === 'feature').length;

  return {
    repo: options.repoKey ?? repoDir,
    startedAt,
    finishedAt: new Date().toISOString(),
    packages,
    warnings,
    pinConflicts,
    apiVersionPins: pinScan.apiVersions,
    counts: {
      packagesAnalyzed: packages.filter((p) => p.status === 'analyzed').length,
      packagesSkipped: packages.filter((p) => p.status !== 'analyzed').length,
      breaking,
      deprecation,
      callSites: callSiteCount,
      pinConflicts: pinConflicts.length,
      vulnerabilities,
      lint,
      freshness,
      features,
    },
  };
}
