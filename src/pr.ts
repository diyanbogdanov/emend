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
import { renderReviewFindings } from './reviewharness.ts';
import { verificationPassed } from './verify.ts';
import type { Asker } from './harness.ts';
import type { FixResult } from './fix.ts';
import type { CallSite, CommandResult, SurfaceChange } from './types.ts';

const execFileAsync = promisify(execFile);

function verdictBadge(outcome: string): string {
  switch (outcome) {
    case 'verified':
      return '✅ **Verified** — baseline passed, post-change typecheck and tests passed';
    case 'typecheck-only':
      return '⚠️ **Types only** — typecheck passes, but the tests did not run. Behaviour is NOT verified.';
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

/**
 * Branch-safe slug for a package name.
 *
 * A scoped package run through a naive character filter keeps the leading
 * separator from its `@`, producing `emend/-radix-ui-react-avatar-1.2.6`. Git
 * accepts it and it looks like a mistake in every branch listing the team sees.
 */
export function branchSlug(pkg: string): string {
  return pkg
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/** Added lines that trade a type check for a compile. */
export function countTypeEscapes(diff: string): number {
  let count = 0;
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    if (/(:\s*any\b|\bas\s+any\b|as\s+unknown\s+as\b|@ts-ignore|@ts-expect-error)/.test(line)) {
      count++;
    }
  }
  return count;
}

export function renderPrTitle(result: FixResult): string {
  const { finding } = result;
  const symbol = finding.change.path;
  return `fix(${finding.pkg}): migrate \`${symbol}\` for ${finding.pkg}@${finding.toVersion}`;
}

/**
 * A reviewer's starting point, written by a model from Emend's own evidence.
 *
 * The one thing this body could not say. Every other section reports what
 * happened — the contract that changed, the sites it reaches, the commands that
 * ran — and a reviewer facing nine call sites and a green table still has no
 * idea which one is worth reading. Facts do not prioritise themselves.
 *
 * Deliberately never a verdict. `verification` decides whether the change is
 * safe, from evidence, and a model sentence reading "low risk" above a
 * regression badge would be a body that contradicts itself in a way a reader
 * cannot adjudicate. The model is asked where to look, never whether it is fine.
 */
export interface PrSummary {
  /** Named in the body: a reader who cannot tell what a model wrote cannot weight it. */
  model: string;
  /** What the change does, in the repository's terms rather than the diff's. */
  says: string;
  /** Specific places worth a reader's attention, and why each one. */
  checks: Array<{ path: string; why: string }>;
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
  /**
   * The model's review guide, when one was produced.
   *
   * Passed in rather than fetched here, which keeps this function pure and
   * synchronous — the same reason `hosted` is a parameter. It also makes the
   * model an input a caller can decline to supply, so an offline run renders a
   * body that is smaller rather than one that is broken.
   */
  summary?: PrSummary;
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

  // Below the verdict, above the evidence. A reviewer reads top-down and stops
  // when they think they understand; the verdict has to be the first thing they
  // meet, and the guide to the evidence has to come before the evidence itself
  // or it is a summary of something they have already waded through.
  if (options.summary) {
    const s = options.summary;
    lines.push('## What to look at');
    lines.push('');
    lines.push(s.says);
    lines.push('');
    for (const check of s.checks) {
      lines.push(`- \`${check.path}\` — ${check.why}`);
    }
    if (s.checks.length > 0) lines.push('');
    lines.push(
      `_Written by \`${s.model}\` from the contract diff, the located call sites and the ` +
        'change itself. It is a reading guide, not a verdict — the verification above is ' +
        'the verdict, and it comes from commands that actually ran._',
    );
    lines.push('');
  }

  lines.push('## Affected call sites');
  lines.push('');
  // Without this, a reader sees line numbers and expects to find them in the
  // diff. When the bump alone typechecks there is nothing to find, and the
  // list looks like a promise the pull request did not keep.
  //
  // Which of those it is cannot be read off `appliedEdits` alone. Zero edits
  // over a green verification means the new version accepted these lines as
  // they stand; zero edits over a failed one means nothing was applied, and
  // saying they "needed no edit" there contradicts the verification table on
  // the same page. Measured: the first end-to-end run rendered exactly that,
  // over `FAIL (exit 2)`.
  const checkedClean = result.appliedEdits === 0 && !!result.verification &&
    verificationPassed(result.verification.outcome);
  lines.push(
    checkedClean
      ? '_These lines use the changed symbol. They were checked against the new ' +
        'version and needed no edit — they are listed so you can confirm that yourself._'
      : result.appliedEdits === 0
        ? '_These lines use the changed symbol. Nothing was applied to them — see ' +
          'the verification above for what happened — so they are where to start reading._'
        : '_These are the lines the change reaches. Edits below apply to them._',
  );
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
  } else if (result.harness) {
    // Model-written changes are labelled distinctly. A reviewer deserves to know
    // which lines a model wrote versus which a deterministic rule produced, and
    // a model writing them is now the only way they get written at all.
    lines.push(
      `**Kind:** 🤖 model-generated — written by \`${result.harness.id}\` in an isolated worktree, then gated and verified.`,
    );
    lines.push('');
    lines.push(
      'The model was given the API contract diff, the located call sites, and the ' +
        'set of symbols that exist in the new version. It worked in an isolated ' +
        'worktree with tools, and every region it changed was checked against that ' +
        'evidence before anything was verified.',
    );
    lines.push('');

    // Regions the model changed that the evidence did not ask for. Reverted
    // rather than kept, and named rather than hidden: they are usually valid
    // code, which is exactly why verification cannot be what catches them, and
    // why a reviewer should know they were attempted.
    const reverted = result.harness.revertedHunks;
    if (reverted.length > 0) {
      lines.push(
        `<details><summary>${reverted.length} change(s) reverted as not required by this upgrade</summary>`,
      );
      lines.push('');
      for (const r of reverted) {
        lines.push(`- \`${r.hunk.file}:${r.hunk.start}\` — ${r.reason}`);
      }
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }

    lines.push(`Edits applied: **${result.appliedEdits}**.`);
  } else if (result.appliedEdits === 0 && verification && verification.outcome !== 'regression') {
    // The bump alone satisfied the type checker. Saying "this needs a human"
    // next to a green verification table reads as a contradiction, and it is:
    // no source change was required, which is the *good* outcome and the whole
    // point of listing the call sites — they were checked, not skipped.
    lines.push(
      '**No source changes were needed.** The version bump alone typechecks: every ' +
        'call site listed above still satisfies the new version\'s type contract. ' +
        'This pull request is the upgrade itself, plus the evidence that your code ' +
        'survives it.',
    );
  } else {
    lines.push(
      `No deterministic transformation was available: ${result.unplannableReason ?? 'the planner did not record a reason'}. ` +
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

  // Advisory notes from the read-only repo-wide pass. Placed before the harness
  // section because they are about the change rather than about how it was
  // produced, and a reviewer reads for the former.
  const notes = renderReviewFindings(result.reviewNotes ?? []);
  if (notes) {
    lines.push('');
    lines.push(notes);
  }

  // What a harness did, when one was reached for. Collected all along and never
  // shown, which left a reviewer unable to tell a diff written by an agent with
  // write access from one produced by pattern substitution — the difference that
  // decides how closely they should read it.
  if (result.harness) {
    const h = result.harness;
    lines.push('');
    lines.push('### Harness escalation');
    lines.push('');
    if (!h.ok) {
      // The most expensive step in the pipeline. A run that declined to happen
      // looks identical to one that tried, unless it is written down.
      lines.push(`Emend escalated to \`${h.id}\`, which did not run: ${h.reason ?? 'no reason given'}.`);
    } else {
      lines.push(
        `Structured edits did not settle this upgrade, so Emend escalated to \`${h.id}\` — ` +
          'an agent working directly in the throwaway workspace, with read and write ' +
          'access to it. Everything it wrote was held to the same evidence rule as a ' +
          'proposed edit: a changed region the failure did not ask for is reverted ' +
          'before anything is verified.',
      );
      lines.push('');
      lines.push(`**${h.keptHunks}** changed region(s) kept, **${h.revertedHunks.length}** reverted.`);
      if (h.log.trim()) {
        lines.push('');
        lines.push(`<details><summary>What \`${h.id}\` reported</summary>`);
        lines.push('');
        lines.push('```');
        lines.push(h.log.trim().slice(0, 2000));
        lines.push('```');
        lines.push('');
        lines.push('</details>');
      }
    }

    // Named rather than counted, for the same reason the withheld edits above
    // are: they are usually valid code, which is exactly why verification cannot
    // be what catches them.
    if (h.revertedHunks.length > 0) {
      lines.push('');
      lines.push(
        `<details><summary>${h.revertedHunks.length} region(s) reverted as not required by this upgrade</summary>`,
      );
      lines.push('');
      for (const r of h.revertedHunks) {
        lines.push(`- \`${r.hunk.file}:${r.hunk.start}\` — ${r.reason}`);
      }
      lines.push('');
      lines.push('</details>');
    }
  }
  lines.push('');

  // Verification cannot see this: `any` compiles exactly as well as a correct
  // type, so a migration that silences errors rather than resolving them passes
  // every gate. Counting it is the only way a reviewer finds out.
  const weakened = countTypeEscapes(result.diff);
  if (weakened > 0) {
    lines.push('## Type safety');
    lines.push('');
    lines.push(
      `⚠️ This change adds **${weakened}** type escape(s) — \`any\`, \`as any\`, ` +
        '`as unknown as`, `@ts-ignore` or `@ts-expect-error`. They compile, and ' +
        'verification therefore cannot object to them, but each one removes ' +
        'checking the project previously had. Worth reading those lines closely.',
    );
    lines.push('');
  }

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
/**
 * Commit the workspace and push it to `branch` on origin.
 *
 * Its own function so a test can drive the real thing. This is both the half
 * that broke in production and the half that runs without `gh`, so a test that
 * reimplemented it would have stayed green through the very regression it was
 * written to catch.
 */
export async function commitAndPush(
  repoDir: string,
  branch: string,
  message: string,
): Promise<{ ok: boolean; error?: string }> {
  // No local branch is created. The workspace is already on a detached HEAD,
  // and a commit can be pushed to a remote ref without one.
  //
  // `git checkout -B <branch>` was the previous approach and it fails outright
  // when any other worktree in the repository has that branch checked out:
  //
  //   fatal: 'emend/recharts-…' is already used by worktree at '…'
  //
  // The holder is normally the developer's own checkout, because reviewing a
  // pull request means checking its branch out. Reclaiming it is not an option
  // — it may hold uncommitted work — so the update simply could not proceed on
  // exactly the repositories where someone was paying attention.
  await execFileAsync('git', ['-C', repoDir, 'add', '-A']);

  // Nothing staged means the migration produced no committable change —
  // report that rather than failing with git's opaque exit code 1.
  const { stdout: staged } = await execFileAsync('git', [
    '-C', repoDir, 'diff', '--cached', '--name-only',
  ]);
  if (staged.trim() === '') {
    return { ok: false, error: 'no changes to commit — the migration produced no file edits' };
  }

  await execFileAsync('git', ['-C', repoDir, 'commit', '-m', message]);

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
    // Explicit source:destination, so no local branch has to exist. `-u` is
    // gone with it: there is nothing local to set upstream on.
    'origin', `HEAD:refs/heads/${branch}`,
  ]);
  return { ok: true };
}

export async function createPullRequest(
  options: CreatePrOptions,
): Promise<{ ok: boolean; url?: string; error?: string }> {
  const { repoDir, branch, title, body, draft = true } = options;
  try {
    const pushed = await commitAndPush(repoDir, branch, title);
    if (!pushed.ok) return pushed;

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

/**
 * Ask for a reading guide, and rule out the two answers that would hurt.
 *
 * Not a verdict, because `verification` already is one and it came from
 * commands that ran. Not a restatement of the diff either — the body renders
 * the contract change, the call sites and the commands directly below this, and
 * a paragraph re-narrating them costs the reader attention while adding nothing.
 *
 * What is left is the thing none of those sections can do: say which of nine
 * call sites is the one to read, and why that one.
 */
export function prSummaryPrompt(input: {
  pkg: string;
  fromVersion: string;
  toVersion: string;
  change: SurfaceChange;
  sites: CallSite[];
  diff: string;
  outcome: string;
}): string {
  return [
    `\`${input.pkg}\` is going ${input.fromVersion} -> ${input.toVersion}. \`${input.change.path}\` ${input.change.kind}, and this repository uses it.`,
    '',
    'Write the note a reviewer reads first: what this change actually does to this codebase, and which lines deserve their attention.',
    '',
    '```diff',
    `- ${input.change.path}: ${truncate(input.change.before ?? '(absent)', 600)}`,
    `+ ${input.change.path}: ${truncate(input.change.after ?? '(removed)', 600)}`,
    '```',
    '',
    'Call sites:',
    ...input.sites.slice(0, 40).map((s) => `- ${s.file}:${s.line}  ${s.text.trim().slice(0, 160)}`),
    '',
    'The change that was made:',
    '```diff',
    input.diff.slice(0, 10_000),
    '```',
    '',
    `Verification already ran and returned \`${input.outcome}\`. That is the verdict and it is not yours to give — do NOT say whether this is safe, low risk, or ready to merge. A reviewer who wants the verdict reads the table.`,
    '',
    'Do not restate the diff, the call site list, or the commands — all three are rendered directly below your note. Do not comment on style or naming.',
    '',
    'Two things only:',
    '- `says`: one or two sentences on what changes about this codebase\'s BEHAVIOUR, in its own terms. If the answer is that nothing does, say that plainly.',
    '- `checks`: the specific places worth reading, each with the reason it stands out from the others. Every `path` must be a file that appears above. An empty list is a real answer when no site is more interesting than the rest.',
    '',
    'Answer with a JSON object on its own line: {"says": "...", "checks": [{"path": "...", "why": "..."}]}',
  ].join('\n');
}

/**
 * Read the model's answer, and refuse it if it invented a file.
 *
 * The guard that matters. A prompt instruction not to hallucinate is a wish; the
 * evidence is right here, so a `path` naming a file that appears in neither the
 * call sites nor the diff can be *checked* — and a model confident enough to
 * invent one has told you what its prose is worth. Dropping the bad check and
 * keeping the paragraph would leave the least trustworthy part on the page.
 */
export function parsePrSummary(
  log: string,
  known: ReadonlySet<string>,
): Omit<PrSummary, 'model'> | null {
  const candidates = [...log.matchAll(/\{[\s\S]*?"says"[\s\S]*?\}\s*\}|\{[\s\S]*?"says"[\s\S]*?\]\s*\}/g)];
  for (const raw of candidates.reverse()) {
    let parsed: { says?: unknown; checks?: unknown };
    try {
      parsed = JSON.parse(raw[0]) as { says?: unknown; checks?: unknown };
    } catch {
      continue;
    }
    if (typeof parsed.says !== 'string' || parsed.says.trim() === '') continue;
    const offered = Array.isArray(parsed.checks) ? parsed.checks : [];
    const checks = offered
      .map((c) => c as { path?: unknown; why?: unknown })
      .filter(
        (c): c is { path: string; why: string } =>
          typeof c.path === 'string' && typeof c.why === 'string' && c.why !== '' && known.has(c.path),
      );
    if (checks.length === 0 && offered.length > 0) return null;
    return { says: parsed.says.trim(), checks };
  }
  return null;
}

/** Files the evidence actually mentions, so an invented one can be spotted. */
function filesInEvidence(result: FixResult): Set<string> {
  const files = new Set(result.finding.sites.map((s) => s.file));
  for (const line of result.diff.split('\n')) {
    const match = line.match(/^\+\+\+ b\/(.+)$/);
    if (match?.[1]) files.add(match[1]);
  }
  return files;
}

/**
 * The reading guide for one migration, or nothing.
 *
 * Nothing is a real outcome and stays silent: an unreachable model, an
 * unparseable answer, or one that named a file it made up. The body renders
 * smaller in every one of those cases, which is the correct degradation — a
 * heading with an apology under it is still a claim about a model that did not
 * speak.
 */
export async function summarisePr(asker: Asker, result: FixResult): Promise<PrSummary | null> {
  const answer = await asker.ask(
    'You brief a reviewer on someone else\'s dependency migration. You are read-only and report to a human. Be specific and short; a sentence that would be true of any migration is worth nothing here.',
    prSummaryPrompt({
      pkg: result.finding.pkg,
      fromVersion: result.finding.fromVersion,
      toVersion: result.finding.toVersion,
      change: result.finding.change,
      sites: result.finding.sites,
      diff: result.diff,
      outcome: result.verification?.outcome ?? 'unverified',
    }),
    { json: true },
  );
  if (answer === null) return null;

  const parsed = parsePrSummary(answer, filesInEvidence(result));
  return parsed ? { model: asker.model, ...parsed } : null;
}
