/**
 * Translates GitHub webhook events into stored state and queued work.
 *
 * Everything here treats the payload as untrusted input: only structured fields
 * are read, and no value from a payload is ever interpolated into a command,
 * path, or query. Signature verification happens before parsing, against the
 * raw bytes — re-serialising parsed JSON produces different bytes and would
 * invalidate an otherwise-valid signature.
 */

import type { Store } from '../store.ts';
import { repoKey } from './app.ts';

export interface WebhookResult {
  /** What was done, for the delivery log. Never contains payload content. */
  action: string;
  jobsQueued: number;
}

interface RepoPayload {
  name?: string;
  full_name?: string;
  owner?: { login?: string };
  default_branch?: string;
}

interface WebhookPayload {
  action?: string;
  installation?: { id?: number; account?: { login?: string } };
  repositories?: RepoPayload[];
  repositories_added?: RepoPayload[];
  repositories_removed?: RepoPayload[];
  repository?: RepoPayload;
  ref?: string;
  after?: string;
  check_suite?: {
    head_branch?: string | null;
    head_sha?: string;
    status?: string;
    conclusion?: string | null;
  };
}

/** `full_name` is `owner/repo`; fall back to it when `owner` is absent. */
function identify(r: RepoPayload | undefined): { owner: string; name: string } | null {
  if (!r) return null;
  const owner = r.owner?.login ?? r.full_name?.split('/')[0];
  const name = r.name ?? r.full_name?.split('/')[1];
  if (!owner || !name) return null;
  return { owner, name };
}

export function handleWebhook(
  store: Store,
  event: string,
  payload: WebhookPayload,
): WebhookResult {
  const installationId = payload.installation?.id;

  switch (event) {
    case 'installation': {
      if (!installationId) return { action: 'ignored: no installation id', jobsQueued: 0 };
      const account = payload.installation?.account?.login ?? 'unknown';

      if (payload.action === 'deleted') {
        for (const r of store.listRepos(installationId)) store.removeRepo(r.repoKey);
        store.suspendInstallation(installationId);
        return { action: 'installation deleted', jobsQueued: 0 };
      }
      if (payload.action === 'suspend') {
        store.suspendInstallation(installationId);
        return { action: 'installation suspended', jobsQueued: 0 };
      }

      store.upsertInstallation(installationId, account);
      const queued = trackRepos(store, installationId, payload.repositories ?? []);
      return { action: `installation ${payload.action ?? 'event'}`, jobsQueued: queued };
    }

    case 'installation_repositories': {
      if (!installationId) return { action: 'ignored: no installation id', jobsQueued: 0 };
      for (const r of payload.repositories_removed ?? []) {
        const id = identify(r);
        if (id) store.removeRepo(repoKey(id.owner, id.name));
      }
      const queued = trackRepos(store, installationId, payload.repositories_added ?? []);
      return { action: 'installation repositories changed', jobsQueued: queued };
    }

    case 'push': {
      const id = identify(payload.repository);
      if (!id) return { action: 'ignored: unidentifiable repository', jobsQueued: 0 };

      // Only the default branch. Feature branches would triple the scan volume
      // and produce findings against code that may never merge.
      const branch = payload.repository?.default_branch;
      if (!branch || payload.ref !== `refs/heads/${branch}`) {
        return { action: 'ignored: not the default branch', jobsQueued: 0 };
      }

      const key = repoKey(id.owner, id.name);
      if (!store.getRepo(key)) {
        return { action: 'ignored: repository not tracked', jobsQueued: 0 };
      }
      store.enqueueJob(key, branch);
      return { action: 'scan queued', jobsQueued: 1 };
    }

    case 'check_suite': {
      // The customer's CI is the verifier for hosted migrations, so its verdict
      // is the evidence a PR is judged on. Only completed suites count: an
      // in-progress suite has concluded nothing.
      const suite = payload.check_suite;
      if (!suite || suite.status !== 'completed') {
        return { action: 'ignored: check suite not completed', jobsQueued: 0 };
      }
      const id = identify(payload.repository);
      const branch = suite.head_branch;
      if (!id || !branch) {
        return { action: 'ignored: incomplete check suite payload', jobsQueued: 0 };
      }

      // `conclusion` is null for suites that were cancelled or skipped; treat
      // anything that is not an explicit success as not-passing.
      const conclusion = suite.conclusion ?? 'unknown';
      const matched = store.recordCiResult(
        repoKey(id.owner, id.name),
        branch,
        suite.head_sha ?? '',
        conclusion,
      );
      return {
        action: matched
          ? `CI ${conclusion} recorded for ${branch}`
          : 'ignored: not an Emend branch',
        jobsQueued: 0,
      };
    }

    default:
      return { action: `ignored: ${event}`, jobsQueued: 0 };
  }
}

/**
 * Record repositories and queue a first scan for each.
 *
 * The initial scan is the product's first impression — a newly connected
 * repository should show findings without waiting for someone to push.
 */
function trackRepos(
  store: Store,
  installationId: number,
  repos: RepoPayload[],
): number {
  let queued = 0;
  for (const r of repos) {
    const id = identify(r);
    if (!id) continue;
    const key = repoKey(id.owner, id.name);
    const branch = r.default_branch ?? 'main';
    store.upsertRepo({
      repoKey: key,
      installationId,
      owner: id.owner,
      name: id.name,
      defaultBranch: branch,
    });
    store.enqueueJob(key, branch);
    queued++;
  }
  return queued;
}
