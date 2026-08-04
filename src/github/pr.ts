/**
 * Opens pull requests through the GitHub API.
 *
 * The CLI path shells out to `git` and `gh` against a local checkout. The hosted
 * path cannot: there is no checkout, and handing an installation token to a
 * subprocess is exactly the exposure the App model exists to avoid. So commits
 * are built with the Git Data API — blobs, a tree, a commit, a ref — which also
 * produces one clean commit rather than one per file.
 *
 * Pull requests are always drafts. Emend proposes; a human merges.
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';

const API = process.env.EMEND_GITHUB_API ?? 'https://api.github.com';

interface GitHubError {
  message?: string;
}

async function call<T>(
  token: string,
  method: string,
  endpoint: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as GitHubError).message ?? '';
    } catch {
      /* no JSON body */
    }
    throw new Error(`GitHub ${res.status} on ${method} ${endpoint}${detail ? `: ${detail}` : ''}`);
  }
  return (await res.json()) as T;
}

export interface FileChange {
  /** Repo-relative path, forward slashes. */
  path: string;
  /** Full new contents. */
  content: string;
}

export interface OpenPrOptions {
  token: string;
  owner: string;
  repo: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
  commitMessage: string;
  files: FileChange[];
}

export interface OpenPrResult {
  ok: boolean;
  url?: string;
  number?: number;
  error?: string;
}

/**
 * Create a branch carrying `files` and open a draft pull request for it.
 *
 * Idempotent on re-run: if the branch already exists it is updated in place
 * (force-updated to the new commit) and the existing PR is reused. A rescan that
 * finds the same drift must not open a second pull request for it.
 */
export async function openPullRequest(opts: OpenPrOptions): Promise<OpenPrResult> {
  const { token, owner, repo, baseBranch, headBranch } = opts;
  const base = `/repos/${owner}/${repo}`;

  try {
    if (opts.files.length === 0) {
      return { ok: false, error: 'no file changes to propose' };
    }

    const baseRef = await call<{ object: { sha: string } }>(
      token,
      'GET',
      `${base}/git/ref/heads/${encodeURIComponent(baseBranch)}`,
    );
    const baseSha = baseRef.object.sha;
    const baseCommit = await call<{ tree: { sha: string } }>(
      token,
      'GET',
      `${base}/git/commits/${baseSha}`,
    );

    // Blobs are uploaded as base64 so that any file content survives intact,
    // including anything that is not valid UTF-8.
    const tree = [];
    for (const file of opts.files) {
      const blob = await call<{ sha: string }>(token, 'POST', `${base}/git/blobs`, {
        content: Buffer.from(file.content, 'utf8').toString('base64'),
        encoding: 'base64',
      });
      tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
    }

    const newTree = await call<{ sha: string }>(token, 'POST', `${base}/git/trees`, {
      base_tree: baseCommit.tree.sha,
      tree,
    });
    const commit = await call<{ sha: string }>(token, 'POST', `${base}/git/commits`, {
      message: opts.commitMessage,
      tree: newTree.sha,
      parents: [baseSha],
    });

    // Create the branch, or move it if a previous run already made one.
    try {
      await call(token, 'POST', `${base}/git/refs`, {
        ref: `refs/heads/${headBranch}`,
        sha: commit.sha,
      });
    } catch {
      await call(token, 'PATCH', `${base}/git/refs/heads/${encodeURIComponent(headBranch)}`, {
        sha: commit.sha,
        force: true,
      });
    }

    const existing = await call<Array<{ html_url: string; number: number }>>(
      token,
      'GET',
      `${base}/pulls?head=${encodeURIComponent(`${owner}:${headBranch}`)}&state=open`,
    );
    const first = existing[0];
    if (first) {
      await call(token, 'PATCH', `${base}/pulls/${first.number}`, {
        title: opts.title,
        body: opts.body,
      });
      return { ok: true, url: first.html_url, number: first.number };
    }

    const pr = await call<{ html_url: string; number: number }>(token, 'POST', `${base}/pulls`, {
      title: opts.title,
      body: opts.body,
      head: headBranch,
      base: baseBranch,
      draft: true,
    });
    return { ok: true, url: pr.html_url, number: pr.number };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Read the files a workspace changed, as the API wants them.
 *
 * Paths are normalised to forward slashes because the Git Data API rejects
 * backslashes, and a Windows-hosted runner would otherwise silently create
 * files with literal backslashes in their names.
 */
export async function collectChangedFiles(
  workspaceDir: string,
  relativePaths: string[],
): Promise<FileChange[]> {
  const files: FileChange[] = [];
  for (const rel of relativePaths) {
    const content = await readFile(path.join(workspaceDir, rel), 'utf8');
    files.push({ path: rel.split(path.sep).join('/'), content });
  }
  return files;
}
