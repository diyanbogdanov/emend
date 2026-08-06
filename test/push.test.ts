import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** execFile, not exec: argument arrays, never a shell string. */
const run = promisify(execFile);

const BRANCH = 'emend/recharts-5f6f9004bebe';

/**
 * The push half of `createPullRequest`, reproduced against a local bare remote.
 *
 * The full function shells out to `gh`, which needs a real GitHub. What broke in
 * production was the git half, and that is exercisable offline.
 */
async function pushFromDetached(repoDir: string, branch: string): Promise<void> {
  await run('git', ['-C', repoDir, 'add', '-A']);
  await run('git', ['-C', repoDir, 'commit', '-m', 'migration']);
  const { stdout: remoteRef } = await run('git', [
    '-C', repoDir, 'ls-remote', 'origin', `refs/heads/${branch}`,
  ]);
  const remoteSha = remoteRef.trim().split(/\s+/)[0] ?? '';
  await run('git', [
    '-C', repoDir, 'push',
    `--force-with-lease=refs/heads/${branch}:${remoteSha}`,
    'origin', `HEAD:refs/heads/${branch}`,
  ]);
}

async function fixture(): Promise<{ root: string; repo: string; cleanup: () => void }> {
  const root = mkdtempSync(path.join(tmpdir(), 'emend-push-'));
  const remote = path.join(root, 'remote.git');
  const repo = path.join(root, 'repo');
  await run('git', ['init', '--bare', '-b', 'main', remote]);
  await run('git', ['clone', remote, repo]);
  await run('git', ['-C', repo, 'config', 'user.email', 't@example.com']);
  await run('git', ['-C', repo, 'config', 'user.name', 'Test']);
  writeFileSync(path.join(repo, 'a.txt'), 'base\n');
  await run('git', ['-C', repo, 'add', '-A']);
  await run('git', ['-C', repo, 'commit', '-m', 'base']);
  await run('git', ['-C', repo, 'push', 'origin', 'main']);
  return { root, repo, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('a branch checked out in another worktree does not block the push', async () => {
  // The real failure, verbatim:
  //   fatal: 'emend/recharts-5f6f9004bebe' is already used by worktree at '…/the-monorepo'
  // The holder was the developer's own checkout — reviewing a PR means checking
  // its branch out — so Emend could not update precisely the PRs someone was
  // looking at. Reclaiming that worktree is not an option; it may hold their work.
  const f = await fixture();
  try {
    // Someone has the PR branch checked out elsewhere, with local edits.
    const held = path.join(f.root, 'held');
    await run('git', ['-C', f.repo, 'branch', BRANCH]);
    await run('git', ['-C', f.repo, 'worktree', 'add', held, BRANCH]);
    writeFileSync(path.join(held, 'a.txt'), 'uncommitted work\n');

    // Emend's workspace: a detached worktree off the same repository.
    const ws = path.join(f.root, 'ws');
    await run('git', ['-C', f.repo, 'worktree', 'add', '--detach', ws, 'main']);
    writeFileSync(path.join(ws, 'a.txt'), 'migrated\n');

    await pushFromDetached(ws, BRANCH);

    const { stdout } = await run('git', ['-C', f.repo, 'ls-remote', 'origin', `refs/heads/${BRANCH}`]);
    assert.match(stdout, /[0-9a-f]{40}/, 'the remote branch should have been updated');

    // And the other worktree's uncommitted work is untouched.
    const { stdout: status } = await run('git', ['-C', held, 'status', '--porcelain']);
    assert.match(status, /a\.txt/, "the holder's local edit must survive");
  } finally {
    f.cleanup();
  }
});

test('the lease still refuses a branch someone else moved', async () => {
  // Dropping the local branch must not drop the protection with it: the push is
  // a force, and the only thing standing between it and someone else's commit is
  // the lease naming the SHA we expect the remote to be at.
  const f = await fixture();
  try {
    const ws = path.join(f.root, 'ws');
    await run('git', ['-C', f.repo, 'worktree', 'add', '--detach', ws, 'main']);
    writeFileSync(path.join(ws, 'a.txt'), 'migrated\n');
    await run('git', ['-C', ws, 'add', '-A']);
    await run('git', ['-C', ws, 'commit', '-m', 'migration']);

    // Someone pushes to the branch after we read its SHA (here: it never existed
    // when we looked, so the lease expects absence).
    const other = path.join(f.root, 'other');
    await run('git', ['-C', f.repo, 'worktree', 'add', '--detach', other, 'main']);
    writeFileSync(path.join(other, 'b.txt'), 'theirs\n');
    await run('git', ['-C', other, 'add', '-A']);
    await run('git', ['-C', other, 'commit', '-m', 'theirs']);
    await run('git', ['-C', other, 'push', 'origin', `HEAD:refs/heads/${BRANCH}`]);

    await assert.rejects(
      run('git', [
        '-C', ws, 'push',
        `--force-with-lease=refs/heads/${BRANCH}:`,
        'origin', `HEAD:refs/heads/${BRANCH}`,
      ]),
      'a stale lease must reject the force-push',
    );
  } finally {
    f.cleanup();
  }
});
