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

import { execFile, spawn } from 'node:child_process';
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
  /**
   * Everything the harness printed. Lossless, and the default for that reason.
   *
   * This field used to hold the summary below, and it cost three separate
   * debugging rounds: a review session whose entire output was a findings
   * object, and a driving session whose output was its report, both summarised
   * to nothing and reported as having produced no output at all. `summarise`
   * keeps tool activity and errors, which is the right thing for a PR body and
   * silently the wrong thing for everyone reading what the model *said*.
   *
   * Lossless by default, summarising by explicit choice.
   */
  log: string;
  /**
   * Which tools ran and what failed — for the PR body, where the log is noise.
   *
   * Optional, and falling back to `log` rather than to nothing. A harness with
   * no summarising step simply has neither, and a consumer that forgets this
   * field gets too much output instead of none — which is the direction a
   * mistake here should fail, given the previous arrangement failed the other
   * way three times.
   */
  summary?: string;
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

/**
 * One line of context when judging, rather than git's default three.
 *
 * Observed live: asked to repair a real error on line 3 and to change something
 * unrelated on line 7 of an eight-line file, opencode did both, and three lines
 * of context merged them into one hunk. That hunk contained a diagnostic, so it
 * was evidenced, and the unrequested change rode in on the back of the repair.
 *
 * One line still gives `git apply` something to verify against — zero context
 * would make a revert unable to detect misapplication — while keeping changes a
 * few lines apart separable, which is the entire point of judging hunks.
 */
const GATE_CONTEXT = '--unified=1';

async function diffFor(dir: string, context: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', dir, 'diff', ...context, '--', '.', ...NOT_SOURCE],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  return stdout;
}

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
    // No pathspec. Naming `.` explicitly makes git refuse the whole command when
    // anything matching it is gitignored — "the following paths are ignored by
    // one of your .gitignore files" — and every real repository ignores
    // `node_modules`, so the baseline could never be taken and the escalation
    // gave up before it started. `.gitignore` already does this job; the
    // exclusions that remain are on the *diff*, where they decide what is shown
    // rather than what is staged.
    await execFileAsync('git', ['-C', dir, 'add', '-A']);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return refused(`cannot establish a git baseline to judge ${harness.id} against — ${why}`);
  }

  try {
    const run = await harness.run(dir, task);

    // Judged at one line of context; reported at git's default, because a
    // reviewer reading the PR wants the surrounding code and the gate does not.
    let diff = '';
    try {
      diff = await diffFor(dir, [GATE_CONTEXT]);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      return refused(`cannot read what ${harness.id} changed — ${why}`, (run.summary ?? run.log));
    }

    if (diff.trim() === '') {
      // An empty diff after an escalation is not a repair, and reporting it as
      // one is how a run that did nothing gets recorded as a run that worked.
      const why = run.ok ? `${harness.id} changed nothing` : `${harness.id} changed nothing — ${run.error ?? 'no reason given'}`;
      return refused(why, (run.summary ?? run.log));
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
      return refused(`could not revert ${drop.length} unrequested hunk(s) — ${reverted.error}`, (run.summary ?? run.log));
    }

    // Re-read at full context, so the reported diff is both what is actually on
    // disk and readable by whoever reviews it.
    let final = diff;
    try {
      final = await diffFor(dir, []);
    } catch {
      // Keep the gating diff rather than claiming an empty one; any revert has
      // already succeeded, and this only affects how the result reads.
    }

    return {
      ok: true,
      log: run.summary ?? run.log,
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
  /**
   * Deny the edit tool, making the run advisory.
   *
   * The review harness uses this. Its output is findings for a human, not a
   * diff, so the write capability buys nothing and costs the whole gate problem:
   * every other harness run is judged by `classifyHunks` reading what it changed,
   * and a run that changes nothing has nothing to judge. Not trusted on its own —
   * `harnessReview` verifies the workspace is unchanged afterwards.
   */
  readOnly?: boolean;
  /**
   * Providers declared inline, so the model is Emend's choice rather than
   * whatever the host's opencode happens to have configured.
   *
   * Without this the harness inherits the user's config, and on a machine whose
   * opencode authenticates through GitHub Copilot that silently means a Claude
   * or GPT model — measured, and contrary to running on open weights. Declaring
   * the provider here does not override a `--harness=<model>` the user pinned;
   * it makes one possible to pin at all.
   */
  providers?: Record<string, unknown>;
  /**
   * MCP servers this session may call, keyed by name.
   *
   * How `emend fix` drives its own loop: it starts an opencode session pointed
   * at Emend's own MCP server, so the agent gets the deterministic primitives —
   * bump, verify, prove the advisory cleared — as tools, and does the repairing
   * itself with the edit rights it already has.
   */
  mcp?: Record<string, unknown>;
  /** `provider/model`, e.g. `openrouter/z-ai/glm-4.6`. Omitted means opencode's own default. */
  model?: string;
  /** An opencode agent definition, if one is configured for this work. */
  agent?: string;
  /**
   * Let the harness run shell commands, so it can check its own work.
   *
   * Off by default. The workspace is a throwaway worktree in which Emend already
   * runs the repository's own build and test scripts, so this is not a new
   * capability at that boundary — but it is the widest one, and it should be a
   * decision rather than something inherited.
   */
  allowBash?: boolean;
  timeoutMs?: number;
}

export interface OpenCodeHarness extends Harness {
  /** Exposed so the flags that make a run safe can be asserted rather than trusted. */
  commandFor(dir: string, message: string): string[];
  /** Likewise for the permissions, which decide whether the run can do anything at all. */
  envFor(): Record<string, string>;
}

/**
 * Whether a harness may run at all, given how far the repository is trusted.
 *
 * `--untrusted` exists so a hosted run executes nothing from the repository or
 * its dependency tree. A harness is an agent whose entire value is going and
 * looking and running things, so pointing one at an untrusted checkout undoes
 * that in a single step — and the verification that would catch a bad outcome is
 * itself suppressed in that mode, so nothing downstream would notice.
 */
export function harnessPermitted(opts: {
  untrusted?: boolean;
}): { ok: true } | { ok: false; reason: string } {
  if (opts.untrusted) {
    return {
      ok: false,
      reason:
        'the repository is marked untrusted, and a harness exists to run things in it',
    };
  }
  return { ok: true };
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Run a child with no stdin at all.
 *
 * `execFile` hands the child an open stdin pipe and never closes it, so a
 * harness that reads stdin blocks forever. Measured, not theorised: the same
 * opencode invocation took 242s through `execFile` — the full timeout — and 34s
 * with stdin closed. A harness sitting on a read is indistinguishable from one
 * that is thinking, so it burns the entire budget before anyone finds out.
 */
function spawnWithoutStdin(
  bin: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env,
      // 'ignore' gives the child /dev/null, so a read returns EOF immediately.
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // A harness that ignores SIGTERM still has to stop.
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, opts.timeoutMs);

    const finish = (code: number): void => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    child.on('error', (err) => {
      stderr += String(err);
      finish(-1);
    });
    child.on('close', (code) => finish(code ?? -1));
  });
}

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

  /**
   * Flags the binary in front of us actually accepts, learned in `available()`.
   *
   * The design spec priced "the harness becomes a dependency whose changes land
   * in this product" as a cost of adoption. It arrived as a CLI contract change:
   * `--auto` is on opencode's development branch and absent from the released
   * 1.x, so hard-coding it made every real run die on a usage error rather than
   * run. Empty until probed, and the command stays conservative until then.
   */
  let supported: ReadonlySet<string> | null = null;

  function commandFor(dir: string, message: string): string[] {
    const args = ['run', message, '--dir', dir, '--format', 'json'];
    // The flag that looks reckless. Where it exists, opencode auto-rejects every
    // tool permission in non-interactive mode without it, and so edits nothing
    // at all. What makes passing it safe is the evidence gate, not its absence.
    if (supported?.has('--auto')) args.push('--auto');
    // No default model. opencode resolves one from the user's own config, and
    // inventing one here would silently override a choice Emend has no business
    // making.
    if (options.model) args.push('--model', options.model);
    if (options.agent) args.push('--agent', options.agent);
    return args;
  }

  /**
   * Permissions, carried as config rather than flags.
   *
   * Measured, not assumed: opencode 1.x rejects tool permissions in
   * non-interactive mode. A real run against this fixture read the file, called
   * `edit`, and got back "The user rejected permission to use this specific tool
   * call" — so without granting them the escalation is a guaranteed no-op that
   * still costs a model call. `OPENCODE_CONFIG_CONTENT` is used rather than a
   * config file because a file written into the workspace would be one more
   * thing to exclude from the very diff the gate is reading.
   */
  function envFor(): Record<string, string> {
    return {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        // Measured: declaring `provider` alone is not enough — without
        // `enabled_providers` opencode keeps resolving through whatever it has
        // authenticated (github-copilot here) and rejects every model, including
        // the open-weight ones it lists. The `{env:...}` template is opencode's
        // own indirection, so the key never enters this JSON.
        ...(options.model?.startsWith('openrouter/')
          ? {
              enabled_providers: ['openrouter'],
              model: options.model,
              provider: { openrouter: { options: { apiKey: '{env:OPENROUTER_API_KEY}' } } },
            }
          : {}),
        ...(options.providers ? { provider: options.providers } : {}),
        ...(options.mcp ? { mcp: options.mcp } : {}),
        permission: {
          edit: options.readOnly ? 'deny' : 'allow',
          bash: options.allowBash ? 'allow' : 'deny',
          // Everything else the harness does lands in a diff that gets judged. A
          // fetch does not — it is the one action leaving no artefact for the
          // gate to read, from a process holding a checkout of someone's private
          // repository.
          webfetch: 'deny',
        },
      }),
    };
  }

  return {
    id: 'opencode',
    commandFor,
    envFor,

    async available(): Promise<HarnessAvailability> {
      try {
        // `--version` is handled by the argument parser before any middleware, so
        // it neither starts a session nor requires provider authentication.
        const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 15_000 });
        const version = stdout.trim().split('\n')[0] ?? '';
        if (!version) return { ok: false, reason: `${bin} --version printed nothing` };
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: `cannot run \`${bin} --version\` — ${why}` };
      }

      try {
        const { stdout } = await execFileAsync(bin, ['run', '--help'], { timeout: 15_000 });
        supported = new Set(stdout.match(/--[a-z][a-z0-9-]*/g) ?? []);
      } catch {
        // Not fatal: `--version` already answered whether the binary runs. An
        // unreadable help text costs the optional flags, not the escalation.
        supported = new Set();
      }
      return { ok: true };
    },

    async run(dir: string, task: HarnessTask): Promise<HarnessRun> {
      const message = task.failureOutput.trim()
        ? `${task.instruction}\n\nThe build currently fails:\n\n${task.failureOutput}`
        : task.instruction;

      const result = await spawnWithoutStdin(bin, commandFor(dir, message), {
        cwd: dir,
        env: { ...process.env, ...envFor() },
        timeoutMs: timeout,
      });

      // opencode sets a non-zero exit imperatively on error, so stdout still
      // holds the events that say what went wrong either way.
      const log = result.stdout;
      const summary = summariseEvents(result.stdout);
      if (result.timedOut) {
        return { ok: false, log, summary, error: `opencode timed out after ${Math.round(timeout / 1000)}s` };
      }
      if (result.code !== 0) {
        return {
          ok: false,
          log,
          summary,
          error: result.stderr.trim() || `opencode exited ${result.code}`,
        };
      }
      return { ok: true, log: log || result.stderr.trim(), summary };
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

/**
 * An opencode session that drives Emend's own tools.
 *
 * The loop `runAgentRepair` used to be, moved to something built for it. Emend
 * still owns everything deterministic — which version clears the advisory, did
 * the build survive, did the vulnerable version actually leave the tree — and
 * those arrive as tools the session cannot fake. What it brings that the deleted
 * loop could not is the ability to read a file nobody thought to load, change
 * its mind about which rung to try, and stop when it is done rather than after
 * a fixed three attempts.
 *
 * `emendCommand` is how this process was started, so the child runs the same
 * build rather than whatever `emend` happens to be on PATH.
 */
export function drivingHarness(options: {
  model?: string;
  emendCommand: string[];
  timeoutMs?: number;
}): OpenCodeHarness {
  return openCodeHarness({
    ...(options.model ? { model: options.model } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    // It has to edit — repairing the break is the entire job it is here for.
    allowBash: true,
    mcp: {
      emend: { type: 'local', command: options.emendCommand, enabled: true },
    },
  });
}

/** What to ask a driving session to do about one finding. */
export function drivePrompt(input: { repo: string; findingId: string; pkg: string }): string {
  return [
    `Fix the ${input.pkg} finding \`${input.findingId}\` in the repository at ${input.repo}.`,
    '',
    'Use the emend MCP tools. They own everything deterministic and you should not reimplement any of it:',
    '- `emend_fix_vulnerability` (or `emend_fix_package`) applies the bump in an isolated workspace and verifies it. It does NOT repair a build the bump breaks — that part is yours.',
    '- `emend_verify` runs the repository\'s own typecheck and tests against the baseline.',
    '- `emend_advisory_status` reads back which versions the lockfile actually resolves.',
    '- `emend_impact` tells you what else references a symbol before you change its shape.',
    '',
    'Then, in the workspace the fix tool returns:',
    '1. If the build broke, repair it. Change only what the compiler is complaining about.',
    '2. Before changing the shape of anything the repository declares, call `emend_impact` on the file. Other callers break silently otherwise.',
    '3. Call `emend_verify` until it passes. If three attempts do not converge, stop and say what is still broken rather than widening the change.',
    '',
    'Two things must BOTH hold before you call it done, and they are separate facts:',
    `- the advisory cleared — confirm with \`emend_advisory_status\`, not by assuming the bump worked;`,
    '- the build passes — confirm with `emend_verify`.',
    '',
    'A green build with the vulnerable version still installed is not a fix; it is the failure most easily mistaken for one. Report both facts plainly, including when one of them is false.',
  ].join('\n');
}

/**
 * The instruction for a wire-contract finding, which is a different job.
 *
 * `drivePrompt` describes a vulnerability: bump a package, repair what the bump
 * broke, confirm the advisory cleared. Handing that text to a wire-contract
 * finding sent a session looking for a GitHub advisory for ten minutes before
 * timing out — it opened by calling the finding "the api.github.com
 * vulnerability", because that is what it had been told.
 *
 * Nothing is bumped here. A call reaches a route the vendor's own description
 * does not contain, the replacement is in that same description, and the repair
 * is an edit at the call sites. So the tools named are the ones that apply and
 * the finishing condition is different: there is no advisory to clear, and a
 * green build proves nothing on its own, because a wrong URL compiles.
 */
export function driveContractPrompt(input: {
  repo: string;
  findingId: string;
  host: string;
  route: string;
  sites: Array<{ file: string; line: number }>;
  description: string;
}): string {
  return [
    `In the repository at ${input.repo}, a call reaches \`${input.route}\` on ${input.host}, and ${input.host}'s own published description does not contain that route.`,
    '',
    `The description is at ${input.description}. Read it — the replacement route is in there.`,
    '',
    'Call sites:',
    ...input.sites.map((s) => `- ${s.file}:${s.line}`),
    '',
    'Use the emend MCP tools:',
    '- `emend_scan` with `contracts: true` lists this finding and any others like it, with their call sites.',
    '- `emend_impact` tells you what else references a symbol before you change its shape.',
    '- `emend_verify` runs the repository’s own typecheck and tests.',
    '',
    'What to do:',
    '1. Find the route the description offers in place of the one being called. Vendors usually rename rather than delete — a singular for a plural, a different noun on the same resource.',
    '2. Decide which replacement fits *this* call by what the code does with the response. A route returning one object and a route returning an array are different replacements, and the surrounding code says which one is expected.',
    '3. Change the URL. Change nothing else unless the response shape forces it.',
    '4. Run `emend_verify`.',
    '',
    'Two things to be honest about, because both are easy to get wrong here:',
    '- A green build is not evidence. A wrong URL is a string and compiles perfectly; only the description says whether the route exists.',
    '- If the description offers no replacement you can justify from the code, say so and change nothing. A guessed URL is worse than the finding, because it looks fixed.',
    '',
    `Report which route you chose, why the surrounding code picked that one over the alternatives, and what \`emend_verify\` said. If you changed nothing, say that plainly and why.`,
  ].join('\n');
}
