/**
 * The migration agent: proposes edits when the deterministic planner cannot.
 *
 * Design follows two findings from the literature rather than the obvious
 * "hand the repo to an agent" approach:
 *
 *  - Byam (arXiv 2505.07522) — end-to-end LLM dependency migration fully fixed
 *    only 27% of builds, and improved markedly when given the API diff, the
 *    failing lines, and compiler feedback. So the model is handed exactly those
 *    three things, and is invoked inside a verify-and-repair loop.
 *  - BigBag (arXiv 2606.24446) — generating one reusable, validated
 *    transformation beats re-improvising a patch per repository. So the model
 *    returns a structured edit set, not a freeform patch.
 *
 * The model never touches the filesystem. It proposes `find`/`replace` pairs;
 * Emend locates them, rejects anything ambiguous or absent, applies the rest,
 * and lets the existing verification decide. A hallucinated edit fails closed.
 */

import type { CallSite, SurfaceChange } from '../types.ts';
import { extractJson } from './client.ts';
import { parseDiagnostics, sameFile, type EditEvidence } from '../gate.ts';
import type { Asker } from '../harness.ts';

export interface TextEdit {
  file: string;
  /** Exact, unique substring to replace. Emend locates it; the model does not. */
  find: string;
  replace: string;
  reason: string;
}

export interface AgentProposal {
  ok: boolean;
  edits: TextEdit[];
  rationale: string;
  /** The model's own confidence, recorded for the PR body — never trusted as a gate. */
  modelConfidence: 'high' | 'medium' | 'low';
  error?: string;
}













function isTextEdit(value: unknown): value is TextEdit {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e['file'] === 'string' &&
    typeof e['find'] === 'string' &&
    typeof e['replace'] === 'string' &&
    e['find'] !== ''
  );
}

/**
 * Send a composed pair of prompts and parse an edit set out of the reply.
 *
 * The whole mechanism, and the only part every job shares. There used to be four
 * near-identical wrappers around it — one per job, each naming a system prompt
 * and a renderer — which made "what does a job consist of" a question you
 * answered by reading four functions. A job is now a `Task`; `harness.runTask`
 * composes one and calls this.
 *
 * Every failure is a value, never a throw. An unreachable model, an unparseable
 * reply and a model that declined are three different things a caller has to be
 * able to tell apart, and an exception collapses them into one.
 */
export async function propose(
  asker: Asker,
  system: string,
  user: string,
): Promise<AgentProposal> {
  const answer = await asker.ask(system, user, { json: true });
  if (answer === null) {
    return {
      ok: false,
      edits: [],
      rationale: '',
      modelConfidence: 'low',
      error: 'the model was unreachable or returned nothing',
    };
  }

  const parsed = extractJson(answer);
  if (!parsed || typeof parsed !== 'object') {
    return {
      ok: false,
      edits: [],
      rationale: '',
      modelConfidence: 'low',
      error: `could not parse a JSON object from the response: ${answer.slice(0, 300)}`,
    };
  }

  const obj = parsed as Record<string, unknown>;
  const rawEdits = Array.isArray(obj['edits']) ? obj['edits'] : [];
  const edits = rawEdits.filter(isTextEdit).map((e) => ({
    file: e.file,
    find: e.find,
    replace: e.replace,
    reason: typeof e.reason === 'string' ? e.reason : 'agent-proposed edit',
  }));

  const confidence = obj['confidence'];
  return {
    ok: true,
    edits,
    rationale: typeof obj['rationale'] === 'string' ? obj['rationale'] : '',
    modelConfidence:
      confidence === 'high' || confidence === 'medium' || confidence === 'low'
        ? confidence
        : 'medium',
  };
}

/**
 * Symbols in the target version that share a container with the changed symbol.
 *
 * Giving the model the real candidate list is the cheapest available defence
 * against invented APIs — it can still hallucinate, but it has no excuse to.
 */
export function nearbySymbols(
  changedPath: string,
  toSymbols: Record<string, { path: string; deprecated: boolean }>,
): string[] {
  const dot = changedPath.lastIndexOf('.');
  const parent = dot === -1 ? '' : changedPath.slice(0, dot);
  const leaf = (dot === -1 ? changedPath : changedPath.slice(dot + 1)).toLowerCase();

  const leafOfRaw = (p: string): string => {
    const i = p.lastIndexOf('.');
    return i === -1 ? p : p.slice(i + 1);
  };
  const leafOf = (p: string): string => leafOfRaw(p).toLowerCase();

  // camelCase and snake_case both split into the words a reader would say.
  const words = (s: string): string[] =>
    s.split(/(?=[A-Z])|[._\-\s]/).filter(Boolean).map((w) => w.toLowerCase());
  const leafWords = words(leafOfRaw(changedPath));

  /**
   * Whether the missing name's words all appear, in order, inside a candidate.
   *
   * `AxiosTransformer` -> `AxiosResponseTransformer` is the shape: a word added
   * in the middle, which no substring test detects.
   *
   * The single-word case returns early because it decides nothing — a lone word
   * matching as a word always matches as a substring too, so bucket 2 has
   * already claimed it. That is a short-circuit, not a rule, and no test guards
   * it: removing the line changes no ranking.
   */
  const insertsInto = (candidateLeaf: string): boolean => {
    if (leafWords.length < 2) return false;
    let i = 0;
    for (const word of words(candidateLeaf)) {
      if (word === leafWords[i]) i += 1;
    }
    return i === leafWords.length;
  };

  // Same-container siblings, *plus* any symbol elsewhere carrying the same leaf
  // name. Restricting to siblings makes a relocated helper — `record` becoming
  // `core.record` — impossible to offer, because the filter runs before the
  // ranking below ever sees it. The model is told to use nothing outside this
  // list, so a migration that moves a symbol between containers could not be
  // expressed at all.
  const out: string[] = [];
  for (const s of Object.values(toSymbols)) {
    if (s.deprecated) continue;
    const sDot = s.path.lastIndexOf('.');
    const sParent = sDot === -1 ? '' : s.path.slice(0, sDot);
    if (sParent === parent || leafOf(s.path) === leaf) out.push(s.path);
  }

  // Rank by name similarity to the symbol that broke, not alphabetically.
  //
  // The prompt can only carry a slice of this list, and the model is instructed
  // to use nothing outside it. Sorting alphabetically buried zod 4's
  // `partialRecord` — the exact replacement for a broken `record` call — at
  // position ~200 of 264, past the cutoff. The model then could not name the one
  // symbol that would have fixed the build, and spent three attempts failing.
  const score = (candidatePath: string): number => {
    const cDot = candidatePath.lastIndexOf('.');
    const cParent = cDot === -1 ? '' : candidatePath.slice(0, cDot);
    const name = leafOf(candidatePath);
    const sibling = cParent === parent;
    if (name === leaf) return sibling ? 0 : 1; // same name, here or relocated
    if (name.includes(leaf)) return 2; // record -> partialRecord, looseRecord
    if (leaf.includes(name)) return 3;
    // A word inserted in the middle, which neither `includes` test can see.
    // Measured live: axios 0.33.0 removes `AxiosTransformer` and exports
    // `AxiosResponseTransformer`, and neither name contains the other, so the
    // real replacement sat in the bottom bucket with every unrelated export. The
    // agent could not name it and weakened the annotation instead.
    if (insertsInto(leafOfRaw(candidatePath))) return 4;
    return 5;
  };

  return out.sort((a, b) => {
    const diff = score(a) - score(b);
    return diff !== 0 ? diff : a.localeCompare(b);
  });
}

// ---------------------------------------------------------------------------
// Evidence: deciding which proposed edits the upgrade actually asked for.
// ---------------------------------------------------------------------------

/** A compiler or test diagnostic, reduced to the location it points at. */

/** `src/schema.ts(28,15): error TS2554: ...` — tsc's own format. */
/** `src/schema.ts:28:15: error ...` — most other tools. */



export interface EditClassification {
  edit: TextEdit;
  evidence: EditEvidence;
  reason: string;
}

/** Tolerate the same file being named relative to different roots. */

/** 1-indexed line span of `find` inside `content`, or null when absent. */
function spanOf(content: string, find: string): { start: number; end: number } | null {
  const index = content.indexOf(find);
  if (index === -1) return null;
  const start = content.slice(0, index).split('\n').length;
  return { start, end: start + find.split('\n').length - 1 };
}

/**
 * Split proposed edits into those the current failure supports and those it does not.
 *
 * The failure mode this exists for is measured, not hypothetical: asked to fix a
 * `z.record` arity break, models also rewrote `.uuid()` and `.email()` at the
 * call sites of *deprecation* findings — extra edits that compile, pass every
 * test, and silently change runtime error messages nobody asked to touch. No
 * later stage can catch that, because the edits are correct; they are merely
 * unnecessary. Rule 3 of the system prompt asks for restraint and the measured
 * model comparison shows asking is not enough.
 *
 * The discriminator is evidence Emend already holds. A diagnostic pointing into
 * an edit's own span is positive evidence the upgrade requires it. A known call
 * site with no diagnostic on it is positive evidence the compiler is content
 * with that line. Anything else — an import rewrite, a Dockerfile the failing
 * test reads — has no evidence either way and is left alone, because dropping it
 * would lose real repairs.
 *
 * This does not weaken rule 7 (fix errors the change list does not explain): the
 * authority here is the diagnostic, not the list, so an unexplained error still
 * evidences its own fix.
 */
export function classifyEdits(
  edits: TextEdit[],
  changes: Array<{ change: SurfaceChange; sites: CallSite[] }>,
  failureOutput: string,
  sources: Map<string, string>,
  /**
   * Paths of deprecation findings the migration has not resolved yet, measured
   * from the files as they currently stand.
   *
   * A deprecated call never produces a compiler error, so a diagnostic-only rule
   * cannot tell the edit that *resolves* the finding from the churn that merely
   * disturbs it. Whether the symbol is still there can.
   */
  unresolvedDeprecations: ReadonlySet<string> = new Set(),
): EditClassification[] {
  const diagnostics = parseDiagnostics(failureOutput);

  // A failing test suite reports no `file(line,col): error` anywhere, so there
  // is no positive evidence for any location. Without that, an edit merely
  // *away* from a call site would count as evidenced by absence of information —
  // and one such edit is enough to start withholding real ones. The gate has to
  // abstain rather than invent a verdict from silence.
  if (diagnostics.length === 0) {
    return edits.map((edit) => ({
      edit,
      evidence: 'evidenced' as const,
      reason: 'the failure reports no diagnostic locations to judge against',
    }));
  }

  return edits.map((edit): EditClassification => {
    const content = sources.get(edit.file);
    const span = content ? spanOf(content, edit.find) : null;
    if (!span) {
      // Unlocatable here means the applicator will reject it anyway; let it, so
      // one place decides and one reason is reported.
      return { edit, evidence: 'evidenced', reason: 'could not be located to judge' };
    }

    const pointedAt = diagnostics.some(
      (d) => sameFile(d.file, edit.file) && d.line >= span.start && d.line <= span.end,
    );
    if (pointedAt) {
      return {
        edit,
        evidence: 'evidenced',
        reason: `a diagnostic points into ${edit.file}:${span.start}`,
      };
    }

    // Which change owns this line, not merely whether some change does: a
    // deprecation that is still outstanding evidences its own repair, and only
    // the owning change can say whether that is the case.
    const owner = changes.find((c) =>
      c.sites.some(
        (s) => sameFile(s.file, edit.file) && s.line >= span.start && s.line <= span.end,
      ),
    );
    if (owner) {
      if (unresolvedDeprecations.has(owner.change.path)) {
        return {
          edit,
          evidence: 'evidenced',
          reason: `${owner.change.path} is deprecated and still present here`,
        };
      }
      return {
        edit,
        evidence: 'unrequested',
        reason: `${edit.file} line ${span.start} is a known call site with nothing outstanding on it`,
      };
    }

    return { edit, evidence: 'evidenced', reason: 'no call site and no diagnostic here' };
  });
}

/** A changed region of a file, as a unified diff describes it. */




/**
 * Keep the edits the failure supports, dropping the rest — unless none are
 * supported, in which case the model's proposal is all there is and verification
 * remains the judge. Silently dropping everything would turn a possible repair
 * into a guaranteed no-op.
 */



/**
 * Keep only the edits that touch a line the linter actually flagged.
 *
 * Stricter than `selectEvidencedEdits`, and deliberately. That one lets an edit
 * through when it finds neither a diagnostic nor a call site, because a
 * dependency bump can genuinely break a file the call-site walk never visited —
 * there is a hidden cause to allow for. Lint has no hidden cause: the findings
 * are the complete list of what is wrong, so an edit away from all of them is
 * the model rewriting something nobody asked about.
 *
 * The window is generous by a couple of lines because a linter reports the head
 * of a construct — the `RUN` — while the fix often spans its continuations.
 */
export function selectLintEdits(
  edits: TextEdit[],
  findings: Array<{ file: string; line: number }>,
  sources: Map<string, string>,
): { keep: TextEdit[]; dropped: EditClassification[] } {
  return selectNearAnchors(
    edits,
    findings,
    sources,
    (edit, span) => `${edit.file} lines ${span.start}-${span.end} carry no linter finding`,
    3,
  );
}

/**
 * Keep only the edits that land near a line something already points at.
 *
 * Shared by the lint and review gates, which differ solely in what counts as an
 * anchor and how the refusal is worded. Two copies of this drift, and the drift
 * would be silent — both gates fail open, so a bug here withholds nothing and
 * looks exactly like a gate that had nothing to withhold.
 *
 * The window is generous by a few lines because a tool reports the head of a
 * construct while the fix often spans its continuations.
 */
function selectNearAnchors(
  edits: TextEdit[],
  anchors: Array<{ file: string; line: number }>,
  sources: Map<string, string>,
  refusal: (edit: TextEdit, span: { start: number; end: number }) => string,
  /**
   * Slack either side of an anchor.
   *
   * Lint needs it: a linter names the head of a construct while the fix spans
   * its continuations. Review does not: the anchor there is the migration's own
   * edit, and a review improving that edit overlaps it — `spanOf` already covers
   * the multi-line case. Slack would licence the drift the gate exists to stop,
   * since three lines is enough to reach the next statement.
   */
  window: number,
): { keep: TextEdit[]; dropped: EditClassification[] } {
  const WINDOW = window;
  const keep: TextEdit[] = [];
  const dropped: EditClassification[] = [];

  for (const edit of edits) {
    const content = sources.get(edit.file);
    const span = content ? spanOf(content, edit.find) : null;
    if (!span) {
      // Unlocatable here means the applicator rejects it anyway; let it, so one
      // place decides and one reason is reported.
      keep.push(edit);
      continue;
    }
    const here = anchors.filter((a) => sameFile(a.file, edit.file));
    const touches = here.some(
      (a) => a.line >= span.start - WINDOW && a.line <= span.end + WINDOW,
    );
    if (touches) keep.push(edit);
    else dropped.push({ edit, evidence: 'unrequested', reason: refusal(edit, span) });
  }
  return { keep, dropped };
}

/**
 * The lines a diff added, numbered against the file as it now stands.
 *
 * Deletions consume no line on the new side and context lines do; getting that
 * backwards shifts every anchor after the first hunk. The `+++ b/file` header
 * also begins with `+` and must not be counted, or every file anchors at line 0
 * and the gate is quietly off.
 */
export function touchedLines(diff: string): Array<{ file: string; line: number }> {
  const out: Array<{ file: string; line: number }> = [];
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
 * The review's evidence gate: it may change what the migration changed.
 *
 * The review is the one stage with no gate, and it showed. Measured on a live
 * security repair, an unanchored review rewrote a working
 * `cancelToken: CancelTokenSource` into `signal: AbortSignal` — altering an
 * *exported* function's signature to modernise an API that carries no
 * deprecation marker. The build stayed green and the advisory stayed cleared,
 * which is precisely why nothing downstream objected: an unnecessary edit that
 * compiles and passes tests is invisible to verification because it is not
 * wrong.
 *
 * The rule is the review prompt's own rule 6, enforced rather than requested.
 * Rule 4 outranks it and is the `deprecated` exemption: a migration that reports
 * "X is deprecated" and ships with X still in the code has not done what it
 * said, and that repair is the review's highest-priority job wherever it lives.
 */
export function selectReviewEdits(
  edits: TextEdit[],
  migrationDiff: string,
  deprecated: Array<{ file: string; line: number }>,
  sources: Map<string, string>,
): { keep: TextEdit[]; dropped: EditClassification[] } {
  return selectNearAnchors(
    edits,
    [...touchedLines(migrationDiff), ...deprecated],
    sources,
    (edit, span) =>
      `${edit.file} lines ${span.start}-${span.end}: the migration did not touch this, and no reported deprecation lives here`,
    0,
  );
}

export function selectEvidencedEdits(classified: EditClassification[]): {
  keep: TextEdit[];
  dropped: EditClassification[];
} {
  const evidenced = classified.filter((c) => c.evidence === 'evidenced');
  if (evidenced.length === 0) return { keep: classified.map((c) => c.edit), dropped: [] };
  return {
    keep: evidenced.map((c) => c.edit),
    dropped: classified.filter((c) => c.evidence === 'unrequested'),
  };
}
