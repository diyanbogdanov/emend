/**
 * The evidence gate: whether a change is one the failure actually asked for.
 *
 * Its own module because both repair strategies need it and neither owns it.
 * The structured path proposes `find`/`replace` pairs and is gated on those; a
 * harness with write access proposes nothing and leaves only a diff, so the
 * same rule is applied to its hunks instead. One question, two inputs.
 *
 * It lived in what was then `llm/agent.ts`, so `harness.ts` imported its own safety
 * property from a module named after the other strategy — the single largest
 * reason the two read as one thing badly split rather than two things that
 * share a judge.
 *
 * Nothing here consults a model, deliberately. This is what decides whether a
 * model's work is allowed to land, and a judge that can be talked round is not
 * one.
 */

import type { CallSite, SurfaceChange } from './types.ts';

export interface Diagnostic {
  file: string;
  line: number;
}

const TSC_DIAGNOSTIC = /^\s*(\S+?)\((\d+),(\d+)\):\s*error\b/gm;

const COLON_DIAGNOSTIC = /^\s*(\S+?):(\d+):(\d+):\s*error\b/gm;

/**
 * Where the failure points, not how much of it there is.
 *
 * `failureSize` in fix.ts already counts errors to drive keep-or-rollback. This
 * is the other half: a count cannot say whether a proposed edit lands somewhere
 * the compiler actually complained about, and that is the only question the
 * evidence gate below can be answered with.
 */
export function parseDiagnostics(output: string): Diagnostic[] {
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  for (const pattern of [TSC_DIAGNOSTIC, COLON_DIAGNOSTIC]) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(output)) !== null) {
      const [, file, rawLine, rawColumn] = m;
      const line = Number(rawLine);
      if (!file || !Number.isFinite(line)) continue;
      const key = `${file}:${line}:${rawColumn}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ file, line });
    }
  }
  return out;
}

export type EditEvidence = 'evidenced' | 'unrequested';

export function sameFile(a: string, b: string): boolean {
  const an = a.replace(/\\/g, '/');
  const bn = b.replace(/\\/g, '/');
  return an === bn || an.endsWith(`/${bn}`) || bn.endsWith(`/${an}`);
}

export interface DiffHunk {
  file: string;
  /** 1-indexed, counted in the new file — the state on disk. */
  start: number;
  end: number;
}

export interface HunkClassification {
  hunk: DiffHunk;
  evidence: EditEvidence;
  reason: string;
}

/**
 * The changed regions of a unified diff.
 *
 * A harness with filesystem access cannot be gated by inspecting proposed
 * `find`/`replace` pairs, because it never proposes any — it writes. The only
 * artefact it leaves behind is the diff, so the gate reads that instead. This is
 * the precondition the design spec puts on adopting one: the fail-closed
 * property is what an agent with write access costs, and it is only recoverable
 * if the gate can judge a diff.
 *
 * Line numbers come from the `+` side of the `@@` header, because that is the
 * state on disk and the state the compiler reports against.
 */
export function parseDiffHunks(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let file = '';
  for (const line of diff.split('\n')) {
    // Cleared per file, so one that carries no hunks — a rename, a mode change —
    // cannot lend its name to the next file's.
    if (line.startsWith('diff --git ')) {
      file = '';
      continue;
    }
    const target = line.match(/^\+\+\+ b\/(.+)$/);
    if (target?.[1]) {
      file = target[1];
      continue;
    }
    // A deletion has no new side, so its old side is the only name it has.
    const source = line.match(/^--- a\/(.+)$/);
    if (source?.[1]) {
      file = source[1];
      continue;
    }
    const header = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!header || !file) continue;
    const start = Number(header[1]);
    const span = header[2] === undefined ? 1 : Number(header[2]);
    if (!Number.isFinite(start)) continue;
    hunks.push({ file, start, end: start + Math.max(0, span - 1) });
  }
  return hunks;
}

/**
 * Judge changed regions by the rule `classifyEdits` applies to proposed edits.
 *
 * Same question, same evidence, different shape — which is what lets the gate
 * survive a harness that writes files instead of proposing text. A diagnostic
 * inside a hunk says the upgrade required it; a known call site inside it with
 * nothing outstanding says the compiler is content with that line; anything else
 * has no evidence either way and is left alone.
 */
export function classifyHunks(
  hunks: DiffHunk[],
  changes: Array<{ change: SurfaceChange; sites: CallSite[] }>,
  failureOutput: string,
  unresolvedDeprecations: ReadonlySet<string> = new Set(),
): HunkClassification[] {
  const diagnostics = parseDiagnostics(failureOutput);

  // Judging from silence is how a gate starts withholding real repairs.
  if (diagnostics.length === 0) {
    return hunks.map((hunk) => ({
      hunk,
      evidence: 'evidenced' as const,
      reason: 'the failure reports no diagnostic locations to judge against',
    }));
  }

  return hunks.map((hunk): HunkClassification => {
    const pointedAt = diagnostics.some(
      (d) => sameFile(d.file, hunk.file) && d.line >= hunk.start && d.line <= hunk.end,
    );
    if (pointedAt) {
      return {
        hunk,
        evidence: 'evidenced',
        reason: `a diagnostic points into ${hunk.file}:${hunk.start}`,
      };
    }

    const owner = changes.find((c) =>
      c.sites.some((s) => sameFile(s.file, hunk.file) && s.line >= hunk.start && s.line <= hunk.end),
    );
    if (owner) {
      if (unresolvedDeprecations.has(owner.change.path)) {
        return {
          hunk,
          evidence: 'evidenced',
          reason: `${owner.change.path} is deprecated and still present here`,
        };
      }
      return {
        hunk,
        evidence: 'unrequested',
        reason: `${hunk.file}:${hunk.start} covers a call site with nothing outstanding on it`,
      };
    }

    return { hunk, evidence: 'evidenced', reason: 'no call site and no diagnostic here' };
  });
}
