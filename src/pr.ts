/**
 * Evidence-rich pull requests.
 *
 * The PR body matters more than the diff. A migration PR from an automated tool
 * is only useful if a reviewer can answer "why am I being asked to merge this?"
 * without leaving the page — what changed upstream, which of my lines it touches,
 * what was verified, and what was NOT verified.
 *
 * Creating a PR is an outward-facing action, so it is opt-in: `render` is pure,
 * and `createPullRequest` only runs when the caller explicitly asks for it.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FixResult } from './fix.ts';
import type { CommandResult } from './types.ts';

const execFileAsync = promisify(execFile);

function verdictBadge(outcome: string): string {
  switch (outcome) {
    case 'verified':
      return '✅ **Verified** — baseline passed, post-change typecheck and tests passed';
    case 'typecheck-only':
      return '⚠️ **Types only** — typecheck passes, but this repository has no test script. Behaviour is NOT verified.';
    case 'regression':
      return '❌ **Regression** — baseline passed but the change failed verification. Do not merge.';
    case 'pre-existing-failure':
      return '⚠️ **Pre-existing failure** — this repository was already failing before the change, so the result is inconclusive.';
    default:
      return '⚠️ **Unverified** — nothing could be run to check this change. Do not treat it as safe.';
  }
}

function cmdLine(label: string, r: CommandResult): string {
  if (r.skipped) return `| ${label} | — | skipped: ${r.skipReason} |`;
  return `| ${label} | \`${r.command}\` | ${r.ok ? 'pass' : `**FAIL** (exit ${r.exitCode})`} |`;
}

export function renderPrTitle(result: FixResult): string {
  const { finding } = result;
  const symbol = finding.change.path;
  return `fix(${finding.pkg}): migrate \`${symbol}\` for ${finding.pkg}@${finding.toVersion}`;
}

export interface PrBodyOptions {
  /**
   * The migration was produced by the hosted analyser, which typechecks but
   * never runs the repository's tests.
   *
   * This changes what the Verification section can honestly claim. Locally,
   * "verified" means the tests passed here. Hosted, the tests have not run at
   * all — the customer's CI will run them on this very branch, and that verdict
   * arrives after the pull request rather than before it. Saying so is the
   * difference between a reviewer trusting the evidence and discovering the gap
   * themselves.
   */
  hosted?: boolean;
}

export function renderPrBody(result: FixResult, options: PrBodyOptions = {}): string {
  const { finding, plan, verification } = result;
  const c = finding.change;

  const lines: string[] = [];

  lines.push('## Why this PR exists');
  lines.push('');
  lines.push(
    `\`${finding.pkg}\` is upgrading **${finding.fromVersion} → ${finding.toVersion}**. ` +
      `The symbol \`${c.path}\` **${c.kind === 'removed' ? 'no longer exists' : c.kind === 'deprecated' ? 'is now deprecated' : 'changed signature'}** ` +
      `in the new version, and this repository uses it.`,
  );
  lines.push('');
  lines.push(
    'This was detected by diffing the published TypeScript declarations of both versions — ' +
      'not from a changelog — so it reflects the actual shipped API surface.',
  );
  lines.push('');

  lines.push('## Verification');
  lines.push('');
  if (options.hosted && verification) {
    lines.push(
      verification.outcome === 'typecheck-only'
        ? '🟡 **Typechecked, tests pending** — the type contract holds. Your CI runs the tests on this branch; that result is the one that matters.'
        : verdictBadge(verification.outcome),
    );
    lines.push('');
    lines.push(
      '_Emend analysed this repository without installing it: dependencies were ' +
        'reconstructed from your lockfile and no install script or test was executed. ' +
        'That is why the tests below are marked as not run — they belong to your CI, ' +
        'which runs them in the environment they were written for._',
    );
    lines.push('');
  } else {
    lines.push(
      verification ? verdictBadge(verification.outcome) : '⚠️ **Unverified** — no verification was run.',
    );
    lines.push('');
  }
  if (verification) {
    lines.push('| Phase | Command | Result |');
    lines.push('| --- | --- | --- |');
    lines.push(cmdLine('Baseline typecheck', verification.baseline.typecheck));
    lines.push(cmdLine('Baseline tests', verification.baseline.test));
    lines.push(cmdLine('Post-change typecheck', verification.post.typecheck));
    lines.push(cmdLine('Post-change tests', verification.post.test));
    lines.push('');
    lines.push(`> ${verification.summary}`);
    lines.push('');
    lines.push(
      '_The baseline runs before any edit, in the same isolated workspace. ' +
        'Without it, a repository that was already failing would have its pre-existing ' +
        'failures blamed on this migration._',
    );
    lines.push('');
  }

  lines.push('## Affected call sites');
  lines.push('');
  lines.push('| File | Line | Source | Resolved via |');
  lines.push('| --- | --- | --- | --- |');
  for (const s of finding.sites) {
    lines.push(
      `| \`${s.file}\` | ${s.line} | \`${s.text.replace(/\|/g, '\\|')}\` | ${s.via} |`,
    );
  }
  lines.push('');

  lines.push('## Exact API contract difference');
  lines.push('');
  lines.push('```diff');
  lines.push(`- ${c.path}: ${truncate(c.before ?? '(absent)')}`);
  lines.push(`+ ${c.path}: ${truncate(c.after ?? '(removed)')}`);
  lines.push('```');
  lines.push('');

  lines.push('## Transformation applied');
  lines.push('');
  if (plan) {
    lines.push(`**Kind:** deterministic \`${plan.kind}\` — no model was involved.`);
    lines.push('');
    lines.push(plan.rationale);
    lines.push('');
    lines.push(`Edits applied: **${result.appliedEdits}** of ${plan.edits.length}.`);
  } else if (result.agent) {
    // Agent-authored changes are labelled distinctly. A reviewer deserves to
    // know which lines a model wrote versus which a deterministic rule produced.
    lines.push(
      `**Kind:** 🤖 model-generated — proposed by \`${result.agent.model}\` via ${result.agent.provider}.`,
    );
    lines.push('');
    lines.push(
      'The model was given the API contract diff, the located call sites, and the ' +
        'set of symbols that exist in the new version. It proposed text edits; Emend ' +
        'located and applied them, rejecting anything ambiguous, then verified the result. ' +
        'The model never had filesystem or shell access.',
    );
    lines.push('');
    if (result.agent.rationale) lines.push(`> ${result.agent.rationale}`);
    lines.push('');
    lines.push('| Attempt | Outcome | Model confidence |');
    lines.push('| --- | --- | --- |');
    for (const a of result.agent.attempts) {
      lines.push(`| ${a.attempt} | ${a.outcome}${a.error ? ` — ${a.error.slice(0, 100)}` : ''} | ${a.modelConfidence} |`);
    }
    lines.push('');
    lines.push(`Edits applied: **${result.appliedEdits}**.`);
  } else {
    lines.push(
      `No deterministic transformation was available: ${result.unplannableReason ?? 'unknown'}. ` +
        'This needs a human.',
    );
  }
  if (result.failedEdits.length > 0) {
    lines.push('');
    lines.push('**Edits that were refused:**');
    for (const f of result.failedEdits) {
      lines.push(`- \`${f.file}${f.line ? `:${f.line}` : ''}\` — ${f.reason}`);
    }
  }
  lines.push('');

  lines.push('## Risks not covered');
  lines.push('');
  lines.push(
    '- Call sites reached through dynamic access (`client[name]()`) are invisible to static analysis and are not included above.',
  );
  lines.push(
    `- Confidence for this finding is **${finding.confidence}**. Medium confidence means the signature changed in a way string comparison cannot classify as safe or breaking.`,
  );
  if (verification && verification.post.test.skipped) {
    lines.push('- **No tests were run.** Only types were checked.');
  }
  lines.push('');

  lines.push('## Rollback');
  lines.push('');
  lines.push('```bash');
  lines.push('git revert --no-edit <merge-commit-sha>');
  lines.push(`npm install ${finding.pkg}@${finding.fromVersion}`);
  lines.push('```');
  lines.push('');
  lines.push(`<sub>Emend finding \`${finding.id}\` · deterministic detection, verified locally before opening.</sub>`);

  return lines.join('\n');
}

function truncate(s: string, max = 300): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export interface CreatePrOptions {
  repoDir: string;
  branch: string;
  title: string;
  body: string;
  draft?: boolean;
  baseBranch?: string;
}

/**
 * Open a draft PR via the `gh` CLI.
 *
 * Deliberately not called by `scan` or `fix` — pushing a branch and opening a PR
 * is visible to other people, so it only happens when a human explicitly asks.
 */
export async function createPullRequest(
  options: CreatePrOptions,
): Promise<{ ok: boolean; url?: string; error?: string }> {
  const { repoDir, branch, title, body, draft = true } = options;
  try {
    // `-B` rather than `-b`: a previous run may have created the branch and then
    // failed later, and re-running after fixing that is the normal case. The
    // branch content is fully determined by the migration, so resetting it is
    // safe and produces the same result.
    await execFileAsync('git', ['-C', repoDir, 'checkout', '-B', branch]);
    await execFileAsync('git', ['-C', repoDir, 'add', '-A']);

    // Nothing staged means the migration produced no committable change —
    // report that rather than failing with git's opaque exit code 1.
    const { stdout: staged } = await execFileAsync('git', [
      '-C', repoDir, 'diff', '--cached', '--name-only',
    ]);
    if (staged.trim() === '') {
      return { ok: false, error: 'no changes to commit — the migration produced no file edits' };
    }

    await execFileAsync('git', ['-C', repoDir, 'commit', '-m', title]);

    // Push with an *explicit* lease against the SHA the remote actually has.
    //
    // The bare `--force-with-lease` form compares against a remote-tracking ref,
    // which each run's fresh worktree may not have, and it then refuses with
    // "stale info" for a branch a previous run pushed. Naming the expected SHA
    // states the intent directly and keeps the protection: if someone else moved
    // the branch since this check, the push is rejected. An empty value means
    // the branch must not exist yet.
    const { stdout: remoteRef } = await execFileAsync('git', [
      '-C', repoDir, 'ls-remote', 'origin', `refs/heads/${branch}`,
    ]);
    const remoteSha = remoteRef.trim().split(/\s+/)[0] ?? '';
    await execFileAsync('git', [
      '-C', repoDir, 'push',
      `--force-with-lease=refs/heads/${branch}:${remoteSha}`,
      '-u', 'origin', branch,
    ]);

    // Reuse an open PR for this branch instead of failing on the second run.
    const { stdout: existing } = await execFileAsync('gh', [
      'pr', 'list', '--head', branch, '--state', 'open', '--json', 'url', '--jq', '.[0].url // ""',
    ], { cwd: repoDir });
    if (existing.trim() !== '') {
      await execFileAsync('gh', ['pr', 'edit', branch, '--title', title, '--body', body], {
        cwd: repoDir,
      });
      return { ok: true, url: existing.trim() };
    }

    // `--head` is required rather than inferred: inside a git worktree `gh`
    // cannot work out the current branch and aborts with "you must first push
    // the current branch to a remote", even when it has just been pushed.
    const args = ['pr', 'create', '--title', title, '--body', body, '--head', branch];
    if (draft) args.push('--draft');
    if (options.baseBranch) args.push('--base', options.baseBranch);

    const { stdout } = await execFileAsync('gh', args, { cwd: repoDir });
    return { ok: true, url: stdout.trim() };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
