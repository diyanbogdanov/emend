import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { commitAndPush } from '../src/pr.ts';

/** execFile, not exec: argument arrays, never a shell string. */
const run = promisify(execFile);

const BRANCH = 'emend/recharts-5f6f9004bebe';

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
  //   fatal: 'emend/recharts-5f6f9004bebe' is already used by worktree at '…'
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

    const pushed = await commitAndPush(ws, BRANCH, 'migration');
    assert.equal(pushed.ok, true, pushed.error ?? '');

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
  //
  // Spelled out rather than routed through `commitAndPush`, because staleness
  // needs someone else's push to land *between* our read of the SHA and our own
  // push — an interleaving that function has no seam for. What it asserts is
  // that the flag form the function builds is genuinely protective.
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
