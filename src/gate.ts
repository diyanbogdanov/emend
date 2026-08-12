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

/**
 * Errors that stop the compiler reading the rest of a file.
 *
 * A failed import is not one error among many. Every symbol it should have bound
 * is now unresolved, so nothing downstream of it can be typechecked at all — and
 * the silence that produces is indistinguishable, to a line-number gate, from the
 * compiler being satisfied.
 *
 * Measured on openai 3 -> 4. The harness migrated the file correctly in four
 * places; the gate reverted three of them as "covers a call site with nothing
 * outstanding on it", because the import error on line 1 meant lines 7, 22 and
 * 30 carried no diagnostic of their own. What was left was the new import over
 * the old call shapes — a file more broken than the one it started from, scored
 * as a regression the model had actually repaired.
 *
 * TS2305/TS2307/TS2614/TS2724 are the resolution failures: no exported member,
 * cannot find module, and the two "did you mean" variants.
 */
const MASKING_DIAGNOSTIC = /^\s*(\S+?)\((\d+),\d+\):\s*error TS(?:2305|2307|2614|2724)\b/gm;

/**
 * Files where a resolution failure makes the absence of other diagnostics
 * meaningless.
 *
 * This is the cardinal rule applied to the gate itself: *could not check* is not
 * *checked and clean*. Emend refuses that inference about a call site it cannot
 * read and about a route no description covers; a quiet line downstream of a
 * broken import is the same claim, made by the one component whose job is to
 * decide whether a repair may land.
 */
export function maskedFiles(output: string): Set<string> {
  const out = new Set<string>();
  MASKING_DIAGNOSTIC.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MASKING_DIAGNOSTIC.exec(output)) !== null) {
    if (m[1]) out.add(m[1]);
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
 * What justifies a change, and what to do about one nothing justifies.
 *
 * The three jobs that write code disagree about this, and flattening them to one
 * rule breaks the strictest. Review runs on a **green build**: it has no
 * diagnostics at all, so a diagnostics-only gate would find nothing to judge
 * against and pass everything — including the out-of-scope churn that is the only
 * thing it is gated for. Lint has no hidden cause: its findings are the complete
 * list of what is wrong, so a change away from all of them is the model rewriting
 * something nobody asked about. Migration has both a hidden cause and silence to
 * survive.
 *
 * So the caller states its evidence and its policy, and the rule below is one
 * rule. `migrationGate`, `reviewGate` and `lintGate` are the three answers.
 */
export interface HunkGate {
  /** Lines that justify a change here. */
  anchors: ReadonlyArray<Diagnostic>;
  /**
   * Lines Emend knows about where a change is *not* justified — a call site the
   * compiler is content with. Distinct from "unknown": silence about a line
   * Emend never looked at is not evidence that it is fine.
   */
  quiet?: ReadonlyArray<Diagnostic>;
  /** Slack either side of an anchor, in lines. */
  window?: number;
  /**
   * A hunk matching neither list.
   *
   * `allow` when there can be a cause Emend cannot see — a bump breaks
   * Dockerfiles and CI config the call-site walk never visits. `revert` when the
   * anchors are the complete statement of what is wrong.
   */
  unanchored: 'allow' | 'revert';
  /**
   * `anchors` empty.
   *
   * `abstain` allows everything: a failing test suite reports no locations, and
   * judging from silence is how a gate starts withholding real repairs.
   */
  whenNoAnchors?: 'abstain' | 'judge';
  /** Names the evidence in the reason line, e.g. "a diagnostic", "the migration". */
  evidenceName?: string;
}

/**
 * Lines a diff added, on the new side — the migration's own footprint.
 *
 * The review gate's anchor set. A review edit that overlaps none of these is not
 * reviewing the migration; it is rewriting code the migration never touched, and
 * out-of-scope churn buries the change under noise.
 */
export function touchedLines(diff: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  let file = '';
  let next = 0;

  for (const line of diff.split('\n')) {
    const header = line.match(/^\+\+\+ (?:b\/)?(.+)$/);
    if (header?.[1]) {
      file = header[1].trim();
      continue;
    }
    if (line.startsWith('--- ')) continue;
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk?.[1]) {
      next = Number(hunk[1]);
      continue;
    }
    if (!file) continue;
    if (line.startsWith('+')) out.push({ file, line: next++ });
    else if (line.startsWith(' ') || line === '') next += 1;
  }
  return out;
}

/**
 * Migration and tightening: the compiler points, and a deprecation still present
 * counts even though it never produces a diagnostic.
 *
 * `unanchored: 'allow'` because a version bump genuinely breaks files the
 * call-site walk never visits. `whenNoAnchors: 'abstain'` because a failing test
 * suite reports no locations at all.
 */
export function migrationGate(
  changes: Array<{ change: SurfaceChange; sites: CallSite[] }>,
  failureOutput: string,
  unresolvedDeprecations: ReadonlySet<string> = new Set(),
): HunkGate {
  const anchors = parseDiagnostics(failureOutput);
  const masked = maskedFiles(failureOutput);
  const quiet: Diagnostic[] = [];
  for (const { change, sites } of changes) {
    // A deprecated symbol still in the source is work the finding asked for, so
    // its call sites justify a change rather than forbidding one.
    const outstanding = unresolvedDeprecations.has(change.path);
    for (const site of sites) {
      const point = { file: site.file, line: site.line };
      // A call site in a file whose imports failed to resolve is not a line the
      // compiler is content with — it is a line the compiler never reached. Both
      // lists would be a lie, so it goes in neither, and the hunk falls through
      // to `unanchored: 'allow'` where verification decides.
      if (outstanding) anchors.push(point);
      else if (!masked.has(site.file)) quiet.push(point);
    }
  }
  return {
    anchors,
    quiet,
    unanchored: 'allow',
    whenNoAnchors: 'abstain',
    evidenceName: 'a diagnostic',
  };
}

/**
 * Review: the only thing that justifies an edit is the migration's own diff.
 *
 * No abstain and no `allow`. The pass runs on a build that already passes, so
 * there is nothing to be silent about — an edit outside the diff is out-of-scope
 * churn by definition, which is the single thing this gate exists to stop. No
 * window either: the anchor is the migration's own edit, and a review improving
 * that edit overlaps it. Three lines of slack is enough to reach the next
 * statement, which is exactly the drift being prevented.
 */
export function reviewGate(
  migrationDiff: string,
  /**
   * Call sites of deprecations the migration reported and did not finish.
   *
   * Rule 4 of the review task outranks rule 6: finishing a deprecation is the
   * migration completing its job, and the use it has to remove is frequently
   * nowhere near the lines the migration touched. Without these the gate reverts
   * exactly the repair the task ranks first.
   */
  unfinishedDeprecations: ReadonlyArray<Diagnostic> = [],
): HunkGate {
  return {
    anchors: [...touchedLines(migrationDiff), ...unfinishedDeprecations],
    unanchored: 'revert',
    whenNoAnchors: 'judge',
    evidenceName: 'the migration',
  };
}

/**
 * Lint: the flagged lines, and nothing else.
 *
 * A window, unlike review, because a linter reports the head of a construct —
 * the `RUN` — while the fix often spans its continuations.
 */
export function lintGate(findings: ReadonlyArray<Diagnostic>): HunkGate {
  return {
    anchors: findings,
    window: 3,
    unanchored: 'revert',
    whenNoAnchors: 'judge',
    evidenceName: 'the linter',
  };
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
export function classifyHunks(hunks: DiffHunk[], gate: HunkGate): HunkClassification[] {
  const window = gate.window ?? 0;
  const evidence = gate.evidenceName ?? 'the failure';
  const covers = (points: ReadonlyArray<Diagnostic>, hunk: DiffHunk): boolean =>
    points.some(
      (p) =>
        sameFile(p.file, hunk.file) &&
        p.line >= hunk.start - window &&
        p.line <= hunk.end + window,
    );

  if (gate.anchors.length === 0 && (gate.whenNoAnchors ?? 'judge') === 'abstain') {
    return hunks.map((hunk) => ({
      hunk,
      evidence: 'evidenced' as const,
      reason: 'the failure reports no locations to judge against',
    }));
  }

  return hunks.map((hunk): HunkClassification => {
    if (covers(gate.anchors, hunk)) {
      return { hunk, evidence: 'evidenced', reason: `${evidence} points into ${hunk.file}:${hunk.start}` };
    }
    if (covers(gate.quiet ?? [], hunk)) {
      return {
        hunk,
        evidence: 'unrequested',
        reason: `${hunk.file}:${hunk.start} covers a call site with nothing outstanding on it`,
      };
    }
    return gate.unanchored === 'allow'
      ? { hunk, evidence: 'evidenced', reason: 'nothing known about this line either way' }
      : {
          hunk,
          evidence: 'unrequested',
          reason: `${hunk.file}:${hunk.start} is not anywhere ${evidence} pointed`,
        };
  });
}
