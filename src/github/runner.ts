/**
 * The job runner: claims queued scans and executes them.
 *
 * A scan reads a repository's manifest, lockfile, and TypeScript sources, and
 * fetches published `.d.ts` files from the npm registry. It does not install
 * dependencies, does not run scripts, and does not execute anything from the
 * repository — which is why this can run in-process rather than needing a
 * per-job container. That property is load-bearing; anything added here that
 * executes repository content invalidates it.
 */

import { rm, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Store } from '../store.ts';
import { scanRepo } from '../analyze.ts';
import { fixPackage, type FixResult } from '../fix.ts';
import { renderPrBody, renderPrTitle } from '../pr.ts';
import { openPullRequest, type FileChange } from './pr.ts';
import type { Finding, ScanReport } from '../types.ts';
import {
  fetchRepoTarball,
  installationToken,
  listInstallationRepos,
  repoKey,
  type AppConfig,
} from './app.ts';

export interface RunnerOptions {
  store: Store;
  config: AppConfig;
  /** Emitted for operator logs. Never includes repository content or tokens. */
  log?: (message: string) => void;
  /** Propose migrations as draft PRs. Set false to run as a monitor only. */
  openPullRequests?: boolean;
  /** Let the model attempt migrations the deterministic planner declines. */
  useAgent?: boolean;
}

export interface ProposeOptions {
  store: Store;
  log: (message: string) => void;
  token: string;
  repo: { repoKey: string; owner: string; name: string };
  baseBranch: string;
  workdir: string;
  report: ScanReport;
  useAgent: boolean;
}

/**
 * Turn a scan into draft pull requests, one per package.
 *
 * A version bump is atomic, so every finding for a package is migrated together
 * in one workspace and lands as one pull request. Splitting them would make each
 * look like a regression, because alone each one is insufficient.
 *
 * Verification here is typecheck-only by construction: running the repository's
 * tests would execute code from a repository Emend does not trust. A migration
 * that regresses the type check is never proposed; one that passes is proposed
 * as a draft saying plainly that the tests are the customer CI's job.
 */
export async function proposeMigrations(opts: ProposeOptions): Promise<number> {
  const { store, log, token, repo, report, workdir } = opts;

  const byPackage = new Map<string, Finding[]>();
  for (const pkg of report.packages) {
    if (pkg.findings.length > 0) byPackage.set(pkg.pkg, pkg.findings);
  }
  if (byPackage.size === 0) return 0;

  let opened = 0;
  const workspaces: Array<string | null> = [];
  for (const [pkgName, findings] of byPackage) {
    try {
      // The workspace must survive long enough to read the edited files out of
      // it; fixPackage otherwise deletes it before they can be collected.
      const result = await fixPackage(workdir, findings, {
        useAgent: opts.useAgent,
        // Execute nothing from this repository or its dependencies.
        untrusted: true,
        keepWorkspace: true,
        onProgress: (m: string) => log(`  [${pkgName}] ${m}`),
      });
      workspaces.push(result.workspaceDir);

      // `typecheck-only` is the best outcome available without running tests.
      // Anything else means the types got worse, or nothing was verified at all.
      if (result.verification.outcome !== 'typecheck-only') {
        log(`  [${pkgName}] not proposed: ${result.verification.outcome}`);
        continue;
      }
      // Deliberately not gated on edit count. When a bump alone typechecks, the
      // version change *is* the migration and is worth proposing — "this
      // upgrade is safe for your code" is the same product as "and here is the
      // patch". What matters is that files actually changed.
      const changed = await changedFiles(workdir, result.workspaceDir);
      if (changed.length === 0) {
        log(`  [${pkgName}] not proposed: no file changes`);
        continue;
      }

      const first = findings[0];
      if (!first) continue;
      const single: FixResult = {
        finding: first,
        plan: result.plans[0] ?? null,
        verification: result.verification,
        diff: result.diff,
        appliedEdits: result.appliedEdits,
        failedEdits: result.failedEdits,
        bump: result.bump,
        workspaceDir: result.workspaceDir,
        workspaceMode: result.workspaceMode,
        ...(result.agent ? { agent: result.agent } : {}),
      };

      const branch = `emend/${pkgName.replace(/[^a-z0-9]+/gi, '-')}-${first.toVersion.replace(/[^a-z0-9.]+/gi, '-')}`;
      const pr = await openPullRequest({
        token,
        owner: repo.owner,
        repo: repo.name,
        baseBranch: opts.baseBranch,
        headBranch: branch,
        title: renderPrTitle(single),
        body: renderPrBody(single, { hosted: true }),
        commitMessage: renderPrTitle(single),
        files: changed,
      });

      if (!pr.ok || pr.number === undefined) {
        log(`  [${pkgName}] pull request failed: ${pr.error ?? 'unknown'}`);
        continue;
      }
      store.recordPullRequest({
        repoKey: repo.repoKey,
        number: pr.number,
        branch,
        url: pr.url ?? '',
        findingIds: findings.map((f) => f.id),
      });
      opened++;
      log(`  [${pkgName}] ${pr.url}`);
    } catch (err) {
      log(`  [${pkgName}] migration failed: ${(err as Error).message}`);
    }
  }

  // Workspaces are kept only long enough to read the edits out of them.
  for (const dir of workspaces) {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return opened;
}

/**
 * Files the migration changed, relative to the checkout.
 *
 * Compares the workspace against the original tree rather than using git, since
 * a tarball checkout is not a repository. node_modules is excluded because it is
 * staged, not committed, and would otherwise put thousands of symlinked packages
 * into a pull request.
 */
async function changedFiles(
  originalDir: string,
  workspaceDir: string | null,
): Promise<FileChange[]> {
  if (!workspaceDir) return [];
  const candidates = new Set<string>();

  const walk = async (relative: string): Promise<void> => {
    const abs = path.join(workspaceDir, relative);
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(rel);
      } else if (entry.isFile()) {
        candidates.add(rel);
      }
    }
  };
  await walk('');

  const changes: FileChange[] = [];
  for (const rel of candidates) {
    let after: string;
    try {
      after = await readFile(path.join(workspaceDir, rel), 'utf8');
    } catch {
      continue; // binary or unreadable: not something a migration edits
    }
    let before: string | null = null;
    try {
      before = await readFile(path.join(originalDir, rel), 'utf8');
    } catch {
      before = null;
    }
    if (before !== after) changes.push({ path: rel, content: after });
  }
  return changes;
}

/** Execute one queued job, if any. Returns false when the queue is empty. */
export async function runOneJob(opts: RunnerOptions): Promise<boolean> {
  const { store, config } = opts;
  const log = opts.log ?? (() => {});

  const job = store.claimJob();
  if (!job) return false;

  let workdir: string | null = null;
  try {
    const tracked = store.getRepo(job.repoKey);
    if (!tracked) throw new Error('repository is no longer tracked');

    const token = await installationToken(config, tracked.installationId);

    // The default branch recorded from an `installation_repositories` event is a
    // guess — that payload omits it. Correct it before fetching, or a repo on
    // `master` would fail every scan with a confusing 404.
    let ref = tracked.defaultBranch;
    const actual = (await listInstallationRepos(token)).find(
      (r) => repoKey(r.owner, r.name) === job.repoKey,
    );
    if (actual && actual.defaultBranch !== ref) {
      ref = actual.defaultBranch;
      store.upsertRepo({
        repoKey: job.repoKey,
        installationId: tracked.installationId,
        owner: tracked.owner,
        name: tracked.name,
        defaultBranch: ref,
      });
    }

    log(`scan ${job.repoKey}@${ref}`);
    workdir = await fetchRepoTarball(token, tracked.owner, tracked.name, ref);

    // Staging is not optional here. Without it the type checker cannot resolve
    // the repository's imports, and hosted scans find a fraction of the call
    // sites the CLI does on identical code.
    const report = await scanRepo(workdir, { repoKey: job.repoKey, vendorDeps: true });
    store.recordScan(report, `${tracked.owner}/${tracked.name}`);
    store.markRepoScanned(job.repoKey);

    log(
      `scanned ${job.repoKey}: ${report.counts.breaking} breaking, ` +
        `${report.counts.deprecation} deprecated, ${report.counts.callSites} call site(s)`,
    );

    const opened = opts.openPullRequests === false
      ? 0
      : await proposeMigrations({
          store,
          log,
          token,
          repo: tracked,
          baseBranch: ref,
          workdir,
          report,
          useAgent: opts.useAgent === true,
        });
    if (opened > 0) log(`opened or updated ${opened} pull request(s) for ${job.repoKey}`);

    store.finishJob(job.id);
    return true;
  } catch (err) {
    const message = (err as Error).message;
    store.finishJob(job.id, message);
    log(`failed ${job.repoKey}: ${message}`);
    return true;
  } finally {
    // The checkout is disposable and may be large. Remove the whole temp tree,
    // not just the extracted root.
    if (workdir) await rm(path.dirname(workdir), { recursive: true, force: true });
  }
}

/**
 * Drain the queue, then poll.
 *
 * Returns a stop function. One runner is correct for the current scale; the
 * claim in `claimJob` is already safe for more.
 */
export function startRunner(opts: RunnerOptions, intervalMs = 5000): () => void {
  let stopped = false;
  let running = false;

  const tick = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      // Keep going while there is work, so a burst drains in one pass.
      while (!stopped && (await runOneJob(opts))) {
        /* next job */
      }
    } catch (err) {
      (opts.log ?? (() => {}))(`runner error: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
