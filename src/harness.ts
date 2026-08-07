/**
 * Escalation to a harness that edits the checkout directly.
 *
 * `find`/`replace` over a pre-selected source set cannot go and read the CI
 * config or work out what a build does, and `loadSources` capping the set is a
 * workaround for not being able to look. A harness can look. What it costs is
 * the property that makes structured edits safe: a proposed edit cannot land
 * unless its `find` string matches uniquely, so a hallucinated one is rejected
 * by construction, and an agent with write access has no such constraint.
 *
 * The design spec's condition of adoption is therefore that the evidence gate
 * moves from proposed edits to diff hunks — same rule, different input. That is
 * what this module is: `classifyHunks` already answers the question, and here it
 * is given something to act on. Anything the current failure does not ask for is
 * reverted where it stands, before the result is verified or reported.
 *
 * What does not change is everything the verdict rests on. The worktree, the
 * baseline, and the verdict vocabulary do not care who wrote the bytes.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classifyHunks, parseDiffHunks, type DiffHunk, type HunkClassification } from './llm/agent.ts';
import type { CallSite, SurfaceChange } from './types.ts';

const execFileAsync = promisify(execFile);

export type HarnessAvailability = { ok: true } | { ok: false; reason: string };

export interface HarnessTask {
  /** What the harness is being asked to do, in prose. */
  instruction: string;
  /** The failing output that motivates it. */
  failureOutput: string;
}

export interface HarnessRun {
  ok: boolean;
  /** Whatever the harness reported, for the PR body and for debugging. */
  log: string;
  error?: string;
}

/** An agent that works in a checkout, rather than proposing text edits. */
export interface Harness {
  id: string;
  /** Whether this harness can run here. Checked before every run, never assumed. */
  available(): Promise<HarnessAvailability>;
  /** Work in `dir`. Whatever it leaves on disk is the result. */
  run(dir: string, task: HarnessTask): Promise<HarnessRun>;
}

export interface EscalationGate {
  changes: Array<{ change: SurfaceChange; sites: CallSite[] }>;
  failureOutput: string;
  unresolvedDeprecations?: ReadonlySet<string>;
}

export interface EscalationResult {
  ok: boolean;
  /** Why not, when `ok` is false. Never empty in that case. */
  reason?: string;
  log: string;
  /** What survived the gate, as it now stands on disk. */
  diff: string;
  keptHunks: number;
  revertedHunks: HunkClassification[];
}

// ---------------------------------------------------------------------------
// Patch surgery
// ---------------------------------------------------------------------------

/**
 * Rebuild a patch from a subset of its hunks.
 *
 * A patch is not a list of lines that can be filtered. Drop a hunk without its
 * file header and the remainder is unapplicable; keep a header whose hunks have
 * all gone and `git apply` rejects the file — which would turn a partial revert
 * into no revert at all. So headers are emitted lazily, on the first hunk of
 * theirs that survives.
 *
 * Hunks are identified by `(file, new-side start line)`, the same key
 * `parseDiffHunks` produces, so a classification can be turned into a selection
 * without parsing the diff a second way.
 */
export function filterDiff(diff: string, keep: (file: string, start: number) => boolean): string {
  const out: string[] = [];
  let header: string[] = [];
  let headerEmitted = false;
  let file = '';
  let inHunk = false;
  let keepingHunk = false;

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      header = [line];
      headerEmitted = false;
      file = '';
      inHunk = false;
      keepingHunk = false;
      continue;
    }

    const hunkHeader = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkHeader?.[1]) {
      inHunk = true;
      keepingHunk = keep(file, Number(hunkHeader[1]));
      if (keepingHunk) {
        if (!headerEmitted) {
          out.push(...header);
          headerEmitted = true;
        }
        out.push(line);
      }
      continue;
    }

    if (!inHunk) {
      header.push(line);
      // The new-side path names the file, except for a deletion, where the old
      // side is all there is.
      const target = line.match(/^\+\+\+ (?:b\/)?(.+)$/);
      if (target?.[1] && target[1] !== '/dev/null') file = target[1];
      else {
        const source = line.match(/^--- (?:a\/)?(.+)$/);
        if (source?.[1] && source[1] !== '/dev/null') file = source[1];
      }
      continue;
    }

    if (keepingHunk) out.push(line);
  }

  const patch = out.join('\n');
  return patch.trim() === '' ? '' : patch.endsWith('\n') ? patch : `${patch}\n`;
}

/**
 * Undo the given hunks, leaving every other change in place.
 *
 * Per hunk rather than per file, deliberately. A harness that repairs the real
 * break and also rewrites something unrelated must keep the repair; reverting
 * the file wholesale withholds real work to punish unrelated work, which is the
 * failure mode the gate's own tests warn against.
 */
export async function revertHunks(
  dir: string,
  diff: string,
  drop: DiffHunk[],
): Promise<{ reverted: number; error?: string }> {
  if (drop.length === 0) return { reverted: 0 };

  const keys = new Set(drop.map((h) => `${h.file}:${h.start}`));
  const patch = filterDiff(diff, (file, start) => keys.has(`${file}:${start}`));
  if (patch === '') return { reverted: 0 };

  // Written outside the workspace: a patch file inside it would show up in the
  // very diff this is trying to clean.
  const scratch = await mkdtemp(path.join(tmpdir(), 'emend-revert-'));
  const file = path.join(scratch, 'revert.patch');
  try {
    await writeFile(file, patch, 'utf8');
    await execFileAsync('git', ['-C', dir, 'apply', '--reverse', file]);
    return { reverted: drop.length };
  } catch (err) {
    return { reverted: 0, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// The gate around a harness
// ---------------------------------------------------------------------------

/** Vendored trees are churn, not work — the same exclusions `workspaceDiff` uses. */
const NOT_SOURCE = [':(exclude)package-lock.json', ':(exclude)node_modules', ':(exclude)**/node_modules/**'];

function refused(reason: string, log = ''): EscalationResult {
  return { ok: false, reason, log, diff: '', keptHunks: 0, revertedHunks: [] };
}

/**
 * Run a harness and hold its output to the same evidence rule as a proposed edit.
 *
 * The index is borrowed to establish a baseline: staging everything before the
 * run means the unstaged diff afterwards is exactly what the harness did, and
 * nothing earlier in the pipeline. It is given back in `finally`, because
 * `fixPackage` computes its final diff with a plain `git diff` that would report
 * nothing at all if the deterministic edits were left staged.
 */
export async function escalate(
  harness: Harness,
  dir: string,
  task: HarnessTask,
  gate: EscalationGate,
): Promise<EscalationResult> {
  const status = await harness.available();
  if (!status.ok) return refused(`${harness.id} is unavailable — ${status.reason}`);

  // No gate, no harness. A write-access agent whose output cannot be judged is
  // precisely what the condition of adoption forbids, so failing to establish a
  // baseline stops the escalation rather than waiving the rule.
  try {
    await execFileAsync('git', ['-C', dir, 'add', '-A', '--', '.', ...NOT_SOURCE]);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return refused(`cannot establish a git baseline to judge ${harness.id} against — ${why}`);
  }

  try {
    const run = await harness.run(dir, task);

    let diff = '';
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['-C', dir, 'diff', '--', '.', ...NOT_SOURCE],
        { maxBuffer: 16 * 1024 * 1024 },
      );
      diff = stdout;
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      return refused(`cannot read what ${harness.id} changed — ${why}`, run.log);
    }

    if (diff.trim() === '') {
      // An empty diff after an escalation is not a repair, and reporting it as
      // one is how a run that did nothing gets recorded as a run that worked.
      const why = run.ok ? `${harness.id} changed nothing` : `${harness.id} changed nothing — ${run.error ?? 'no reason given'}`;
      return refused(why, run.log);
    }

    const classified = classifyHunks(
      parseDiffHunks(diff),
      gate.changes,
      gate.failureOutput,
      gate.unresolvedDeprecations ?? new Set(),
    );
    const unrequested = classified.filter((c) => c.evidence === 'unrequested');

    // The carve-out `selectEvidencedEdits` makes, for the same reason: if
    // nothing is evidenced then the harness's work is all there is, and
    // reverting all of it turns a possible repair into a guaranteed no-op.
    // Verification remains the judge.
    const evidenced = classified.length - unrequested.length;
    const drop = evidenced === 0 ? [] : unrequested;

    const reverted = await revertHunks(dir, diff, drop.map((c) => c.hunk));
    if (reverted.error) {
      return refused(`could not revert ${drop.length} unrequested hunk(s) — ${reverted.error}`, run.log);
    }

    // Re-read, so the reported diff is what is actually on disk rather than what
    // was there before the gate acted.
    let final = diff;
    if (reverted.reverted > 0) {
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['-C', dir, 'diff', '--', '.', ...NOT_SOURCE],
          { maxBuffer: 16 * 1024 * 1024 },
        );
        final = stdout;
      } catch {
        // Keep the pre-revert diff rather than claiming an empty one; the revert
        // itself already succeeded.
      }
    }

    return {
      ok: true,
      log: run.log,
      diff: final,
      keptHunks: classified.length - reverted.reverted,
      revertedHunks: drop,
      ...(run.ok ? {} : { reason: run.error ?? `${harness.id} reported a failure` }),
    };
  } finally {
    // Hand the index back. `git reset` with no paths restores it to HEAD and
    // leaves the working tree exactly as it stands.
    await execFileAsync('git', ['-C', dir, 'reset', '-q']).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------------

export interface OpenCodeOptions {
  bin?: string;
  /** `provider/model`, e.g. `openrouter/z-ai/glm-4.6`. Omitted means opencode's own default. */
  model?: string;
  /** An opencode agent definition, if one is configured for this work. */
  agent?: string;
  timeoutMs?: number;
}

export interface OpenCodeHarness extends Harness {
  /** Exposed so the flags that make a run safe can be asserted rather than trusted. */
  commandFor(dir: string, message: string): string[];
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * OpenCode as the escalation harness.
 *
 * Chosen because `llm-harness.md` named a Tier 3 sandboxed harness as the
 * escalation path and declined to build one on the grounds that OpenHands is
 * Python and Docker-bound. OpenCode is TypeScript and MIT, so that objection
 * does not apply.
 */
export function openCodeHarness(options: OpenCodeOptions = {}): OpenCodeHarness {
  const bin = options.bin ?? 'opencode';
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  function commandFor(dir: string, message: string): string[] {
    const args = ['run', message, '--dir', dir, '--format', 'json', '--auto'];
    // No default model. opencode resolves one from the user's own config, and
    // inventing one here would silently override a choice Emend has no business
    // making.
    if (options.model) args.push('--model', options.model);
    if (options.agent) args.push('--agent', options.agent);
    return args;
  }

  return {
    id: 'opencode',
    commandFor,

    async available(): Promise<HarnessAvailability> {
      try {
        // `--version` is handled by the argument parser before any middleware, so
        // it neither starts a session nor requires provider authentication.
        const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 15_000 });
        const version = stdout.trim().split('\n')[0] ?? '';
        return version ? { ok: true } : { ok: false, reason: `${bin} --version printed nothing` };
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: `cannot run \`${bin} --version\` — ${why}` };
      }
    },

    async run(dir: string, task: HarnessTask): Promise<HarnessRun> {
      const message = task.failureOutput.trim()
        ? `${task.instruction}\n\nThe build currently fails:\n\n${task.failureOutput}`
        : task.instruction;
      try {
        const { stdout, stderr } = await execFileAsync(bin, commandFor(dir, message), {
          cwd: dir,
          timeout,
          maxBuffer: 32 * 1024 * 1024,
        });
        return { ok: true, log: summariseEvents(stdout) || stderr.trim() };
      } catch (err) {
        // opencode sets a non-zero exit imperatively on error, so stdout still
        // holds the events that say what went wrong.
        const e = err as { stdout?: string; stderr?: string; message?: string };
        const log = summariseEvents(e.stdout ?? '');
        return { ok: false, log, error: e.stderr?.trim() || e.message || 'opencode failed' };
      }
    },
  };
}

/**
 * Condense `--format json` output.
 *
 * It is JSONL — one event per line, no aggregate result object — so a run's
 * worth of it is far too much for a PR body. Errors and assistant text are what
 * a reader needs; tool-call traffic is not.
 */
export function summariseEvents(stdout: string): string {
  const lines: string[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    let event: { type?: string; text?: string; error?: unknown };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'error') {
      lines.push(`error: ${typeof event.error === 'string' ? event.error : JSON.stringify(event.error)}`);
    } else if (event.type === 'text' && typeof event.text === 'string') {
      lines.push(event.text);
    }
  }
  return lines.join('\n').trim();
}
