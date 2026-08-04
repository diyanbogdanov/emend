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

import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { Store } from '../store.ts';
import { scanRepo } from '../analyze.ts';
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

    const report = await scanRepo(workdir, { repoKey: job.repoKey });
    store.recordScan(report, `${tracked.owner}/${tracked.name}`);
    store.markRepoScanned(job.repoKey);
    store.finishJob(job.id);

    log(
      `done ${job.repoKey}: ${report.counts.breaking} breaking, ` +
        `${report.counts.deprecation} deprecated, ${report.counts.callSites} call site(s)`,
    );
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
