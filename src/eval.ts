/**
 * Measuring the agent, so that changing it is a decision rather than a hope.
 *
 * Two model comparisons were run by hand — zod, and recharts in the pull request
 * that added model defaults — and neither could be compared to the other or
 * re-run to check that a later change did not regress it.
 * In between, the agent gained type-strength rules, partial-progress rollback, a
 * tightening pass, a review pass and an evidence gate, none of it under a gate.
 *
 * The design follows BUMP: a case is a repository frozen where its build passes,
 * plus a version bump that breaks it. What BUMP measures at the build level, Byam
 * showed is too coarse on its own — its best configuration repaired 27% of builds
 * while fixing 78% of the individual compilation errors in the builds that stayed
 * red — so error reduction is recorded alongside the verdict.
 *
 * The metrics that are not about passing are the point. Every failure this
 * project has actually hit was invisible to a green build: six edits where two
 * were required, a green build bought with `any`, and a migration that reported a
 * deprecation and left it in place. The model does what the harness measures, so
 * the harness measures those.
 */

import { rm, readFile, mkdtemp, cp } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanRepo, type ScanOptions } from './analyze.ts';
import { fixPackage } from './fix.ts';
import type { Harness } from './harness.ts';
import { countTypeEscapes } from './pr.ts';
import { remainingDeprecations, resolveChecks, type ResolutionCheck } from './quality.ts';
import type { VerifyOutcome } from './types.ts';

const execFileAsync = promisify(execFile);

/** A repository frozen at a state where its build passes, plus a bump that breaks it. */
export interface EvalCase {
  /** Stable identifier, used as the reporting key. */
  id: string;
  pkg: string;
  toVersion: string;
  /** Where the pre-breaking repository comes from. */
  repo:
    | { kind: 'fixture'; name: string }
    | { kind: 'local'; dir: string }
    | { kind: 'git'; url: string; ref: string };
  /**
   * How many edits the correct migration needs, in logical edits.
   *
   * **The scale a reported ratio is expressed in — not a threshold.** Nothing is
   * judged against this in either direction, and both directions were dropped for
   * their own reason.
   *
   * Under-counting was unsound. `CaseOutcome.editsApplied` counts diff hunks, and
   * a hunk is a contiguous region, so `hunks <= edits` always: fewer hunks than
   * this is equally consistent with a finished migration whose edits merged.
   * Measured rather than argued — all six of zod's required edits, applied to the
   * fixture by hand, produce four hunks at `GATE_CONTEXT`, because its
   * deprecations sit on lines 11, 12 and 14 of `schema.ts` with unchanged context
   * between them. react-query's two are adjacent and produce one. Both cases spent
   * an entire pinned sweep at their ceiling being called incomplete.
   *
   * Over-counting was sound and still wrong to score with: the review pass exists
   * to edit, and a scoreboard that charges it for editing argues with §14 rather
   * than measuring it. See §16.11.
   *
   * Whether the migration finished is `mustResolve`, which reads the code instead
   * of counting regions.
   */
  minimalEdits: number;
  /**
   * What must no longer be in its pre-migration form once the migration is done.
   *
   * The completeness signal, and the reason under-counting is no longer a
   * penalty. Optional because a third-party corpus may make no completeness
   * claim; every built-in case declares one, held by a test, so this corpus
   * cannot regress to unmeasured.
   */
  mustResolve?: ResolutionCheck[];
}

/** What one run of one case under one model produced. */
export interface CaseOutcome {
  caseId: string;
  model: string;
  /**
   * The harness that produced the edits, when one did.
   *
   * Part of the engine's identity, not a detail of the run. §8's condition on
   * adopting a harness is that it swaps the editing engine itself, so folding
   * its runs into the model's own row would make every subsequent result
   * unattributable — two runs of the same model that produced different work for
   * different reasons, averaged into one number.
   */
  harness?: string;
  /** Hunks the gate let through, and hunks it reverted. */
  harnessKept?: number;
  harnessReverted?: number;
  verdict: VerifyOutcome;
  /**
   * Why this run produced no evidence about the migration at all.
   *
   * Set when the harness itself refused or produced nothing — unavailable, or
   * `changed nothing`. Such a run says the engine did not attempt the work; it
   * says *nothing* about whether the migration is repairable, and folding it into
   * `regression` reports a dead provider as a quality result.
   *
   * This is the cardinal rule applied to the benchmark. Emend counts unreadable
   * call sites and uncovered routes rather than scoring them clean; a run whose
   * engine never ran is the same claim, made by the thing that measures.
   */
  inconclusive?: string;
  /**
   * Deterministic edits plus kept diff hunks.
   *
   * A *lower bound* on the work done, because hunks merge. Read as a bound on
   * over-editing only; `unresolved` is what says whether the migration finished.
   */
  editsApplied: number;
  /** Edits the evidence gate withheld — informational, never a penalty. */
  editsWithheld: number;
  /** Symbols the case required and the migration left in their old form. */
  unresolved?: string[];
  /**
   * Completeness checks that could not be evaluated at all.
   *
   * Beside `unresolved` rather than inside it, for the same reason `inconclusive`
   * sits beside the rates: "could not check" and "checked and found wanting" are
   * different claims, and only one of them is about the migration.
   */
  uncheckable?: string[];
  errorsBefore: number;
  errorsAfter: number;
  /** Added lines trading a type check for a compile. */
  typeEscapes: number;
  /** Deprecations the migration claimed and left in place. */
  deprecationGaps: number;
  durationMs: number;
}

export interface CaseScore {
  caseId: string;
  model: string;
  /** The build ended in a state Emend is willing to call a pass. */
  passed: boolean;
  /** Passed *and* cost nothing extra. The metric worth optimising. */
  clean: boolean;
  /** Applied edits over the minimum the migration required. 1 is ideal. */
  editRatio: number;
  /** Proportion of the starting errors that are gone. 0 when none were. */
  errorReduction: number;
  /** Why it was not clean, in the order a reader should care. */
  penalties: string[];
  /** The engine never produced anything, so this run scores nothing either way. */
  inconclusive: boolean;
}

/**
 * Score one run.
 *
 * `passed` and `clean` are deliberately separate. Everything this project has
 * learned the hard way lives in the gap between them: a green build says the
 * migration compiles and its tests pass, and says nothing at all about whether it
 * changed things nobody asked to change, disabled the checker to get there, or
 * did the thing its own commit message claimed.
 */
export function scoreCase(evalCase: EvalCase, outcome: CaseOutcome): CaseScore {
  // `verified` and `typecheck-only` are the two outcomes Emend will stand behind;
  // `unverified` and `pre-existing-failure` are explicitly not, so a benchmark
  // must not launder them into passes.
  const passed = outcome.verdict === 'verified' || outcome.verdict === 'typecheck-only';

  const minimal = Math.max(1, evalCase.minimalEdits);
  const editRatio = outcome.editsApplied / minimal;
  const errorReduction =
    outcome.errorsBefore > 0
      ? Math.max(0, (outcome.errorsBefore - outcome.errorsAfter) / outcome.errorsBefore)
      : 0;

  const penalties: string[] = [];
  if (outcome.inconclusive) penalties.push(`INCONCLUSIVE — ${outcome.inconclusive}`);
  else if (!passed) penalties.push(`did not verify (${outcome.verdict})`);
  if (outcome.deprecationGaps > 0) {
    penalties.push(`${outcome.deprecationGaps} deprecation(s) reported and left in place`);
  }
  if (outcome.typeEscapes > 0) {
    penalties.push(`${outcome.typeEscapes} type escape(s) — a green build bought with \`any\``);
  }
  // Whether the migration finished, read off the code rather than off a count.
  // This is the half of the old edit-count penalty that was worth keeping: the
  // first live sweep ranked qwen3-coder top at 0.4x for fixing two compile errors
  // and skipping all three deprecations, and something has to catch that.
  if (outcome.unresolved && outcome.unresolved.length > 0) {
    penalties.push(
      `${outcome.unresolved.length} symbol(s) left in their pre-migration form: ${outcome.unresolved.join(', ')}`,
    );
  }
  if (outcome.uncheckable && outcome.uncheckable.length > 0) {
    penalties.push(
      `could not check ${outcome.uncheckable.length} completeness requirement(s): ${outcome.uncheckable.join(', ')}`,
    );
  }
  // No edit-count penalty in either direction, and the two were dropped for
  // different reasons. Under-counting was *unsound*: `editsApplied` counts hunks
  // and `minimal` counts edits, so fewer proves nothing — zod's six required
  // edits are four hunks (§16.1).
  //
  // Over-counting was sound and still wrong to score with, because the review
  // pass is supposed to edit. §14 handed the repair's judgement to the reviewer
  // and the commits after it gave the review room to act; charging it for acting
  // argues with the design. Measured: react-query's review changed `isLoading` to
  // `isPending` — the exact behaviour that case says the review "exists to
  // notice" — and the count marked the run down for it. §16.11.
  //
  // `editRatio` is still computed and still reported, as the scope signal
  // `RECHARTS_CASE` always described. It decides nothing.
  if (outcome.verdict === 'typecheck-only') {
    penalties.push('the tests did not run, so behaviour is unverified');
  }

  return {
    inconclusive: outcome.inconclusive !== undefined,
    caseId: outcome.caseId,
    model: outcome.model,
    passed,
    clean: passed && penalties.length === 0,
    editRatio,
    errorReduction,
    penalties,
  };
}

export interface ModelSummary {
  model: string;
  /** Present when these runs escalated to a harness. Part of the row's identity. */
  harness?: string;
  /** Distinct cases this model was run on, however many times each ran. */
  casesRun: number;
  /** Total runs behind these rates. Repeats are how variance becomes visible. */
  runs: number;
  /** Cases in the corpus, so a partial run is visibly partial. */
  casesTotal: number;
  /**
   * Runs whose engine never produced anything, excluded from every rate above.
   *
   * Beside the rates rather than inside them, for the same reason the scan prints
   * "skipped != clean": a rate computed over runs that did not happen is not a
   * worse number, it is a different claim.
   */
  inconclusive: number;
  passRate: number;
  cleanRate: number;
  /** Mean over runs that failed, so partial progress on hard cases stays visible. */
  meanErrorReduction: number;
  meanEditRatio: number;
  totalTypeEscapes: number;
  totalDeprecationGaps: number;
  /**
   * Edits the gate withheld across the sweep.
   *
   * Without this, a model that proposed six edits and applied two scores exactly
   * like one that proposed two — and the gate's own effect, which is the reason
   * it exists, is invisible in the only place it would ever be judged.
   */
  totalEditsWithheld: number;
  /**
   * Hunks a harness wrote and the gate reverted, across the sweep.
   *
   * The same reason `totalEditsWithheld` exists for structured edits: a harness
   * that wrote nine hunks and kept two otherwise scores exactly like one that
   * wrote two, and the gate's effect — the entire condition of adoption — is
   * invisible in the only place it would ever be measured.
   */
  totalHunksReverted: number;
  totalHunksKept: number;
  /**
   * Symbols left in their pre-migration form across the sweep.
   *
   * The same argument `totalEditsWithheld` and `totalHunksReverted` were added
   * under: completeness is the signal that replaced the under-edit penalty, and
   * one absent from the table is invisible in the only place it would be judged.
   */
  totalUnresolved: number;
  totalDurationMs: number;
}

/** Model and harness together: what actually produced the edits. */
function engineKey(outcome: { model: string; harness?: string }): string {
  return `${outcome.model}\u0000${outcome.harness ?? ''}`;
}

const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

/**
 * One row per model.
 *
 * Rates are computed over the cases a model was actually run on, and `casesRun`
 * is reported next to `casesTotal` so a cheap partial sweep cannot masquerade as
 * a full one. Scoring unrun cases as failures would make any two models with
 * different corpora incomparable, which is the one thing this exists to prevent.
 */
export function summarise(cases: EvalCase[], outcomes: CaseOutcome[]): ModelSummary[] {
  const byCase = new Map(cases.map((c) => [c.id, c]));
  const byModel = new Map<string, CaseScore[]>();
  const engines = new Map<string, { model: string; harness?: string }>();
  /** The per-engine totals that are summed rather than averaged. */
  interface Totals {
    escapes: number; gaps: number; ms: number; withheld: number;
    kept: number; reverted: number; unresolved: number;
  }
  const meta = new Map<string, Totals>();
  const zero = (): Totals =>
    ({ escapes: 0, gaps: 0, ms: 0, withheld: 0, kept: 0, reverted: 0, unresolved: 0 });

  for (const outcome of outcomes) {
    const evalCase = byCase.get(outcome.caseId);
    if (!evalCase) continue; // an outcome for a case no longer in the corpus
    const key = engineKey(outcome);
    engines.set(key, {
      model: outcome.model,
      ...(outcome.harness ? { harness: outcome.harness } : {}),
    });
    const scores = byModel.get(key) ?? [];
    scores.push(scoreCase(evalCase, outcome));
    byModel.set(key, scores);

    const m = meta.get(key) ?? zero();
    m.escapes += outcome.typeEscapes;
    m.withheld += outcome.editsWithheld;
    m.gaps += outcome.deprecationGaps;
    m.ms += outcome.durationMs;
    m.kept += outcome.harnessKept ?? 0;
    m.reverted += outcome.harnessReverted ?? 0;
    m.unresolved += outcome.unresolved?.length ?? 0;
    meta.set(key, m);
  }

  return [...byModel.entries()]
    .map(([key, scores]) => {
      const m = meta.get(key) ?? zero();
      const engine = engines.get(key) ?? { model: key };
      // Rates are computed over runs that actually happened. A run whose engine
      // produced nothing is not a failure to average in — it is an absence of
      // evidence, and dividing by it turns a dead provider into a fix rate.
      const ran = scores.filter((s) => !s.inconclusive);
      const denominator = Math.max(1, ran.length);
      const failed = ran.filter((s) => !s.passed);
      return {
        model: engine.model,
        ...(engine.harness ? { harness: engine.harness } : {}),
        casesRun: new Set(scores.map((s) => s.caseId)).size,
        runs: scores.length,
        casesTotal: cases.length,
        inconclusive: scores.length - ran.length,
        passRate: ran.filter((s) => s.passed).length / denominator,
        cleanRate: ran.filter((s) => s.clean).length / denominator,
        // Over the failures only: a pass has nothing left to reduce, and
        // averaging its 100% in would hide how far the failures actually got.
        meanErrorReduction: mean(failed.map((s) => s.errorReduction)),
        meanEditRatio: mean(ran.filter((s) => s.passed).map((s) => s.editRatio)),
        totalTypeEscapes: m.escapes,
        totalDeprecationGaps: m.gaps,
        totalEditsWithheld: m.withheld,
        totalHunksReverted: m.reverted,
        totalHunksKept: m.kept,
        totalUnresolved: m.unresolved,
        totalDurationMs: m.ms,
      };
    })
    // Clean rate decides; churn only breaks ties, and only upward. This ordered
    // by distance from 1.0 while the ratio could err in both directions; once a
    // *correct* migration reads below one — zod's six edits are four hunks —
    // nearest-to-1.0 ranks the run that padded above the run that did the job.
    // A ratio under one is merged hunks and orders no worse than an exact match;
    // above one is more diff for a reader, which is a preference between equals
    // rather than a verdict, since it no longer affects `clean` at all.
    .sort(
      (a, b) =>
        b.cleanRate - a.cleanRate ||
        Math.max(0, a.meanEditRatio - 1) - Math.max(0, b.meanEditRatio - 1),
    );
}

/**
 * Run one case and measure it.
 *
 * The workspace is kept until the metrics are read, because deprecation
 * completeness can only be measured against the migrated files — which is the
 * whole reason it is measured rather than asked for.
 *
 * A case that throws is returned as an `unverified` outcome rather than
 * propagated. One repository failing to install must not void a sweep, and
 * `unverified` is already the verdict Emend refuses to count as a pass, so the
 * failure lands in the scoreboard honestly instead of disappearing from it.
 */
/**
 * The scan a case wants: its package, at the version its id names.
 *
 * Its own function so a test can assert the target actually reaches the scan.
 * It did not, for the whole life of the corpus: `toVersion` was declared, set on
 * every case, and read by nothing, so each run migrated to whatever npm's
 * `latest` was that morning. `openai-3.3.0-to-4.104.0` was performing 3.3.0 ->
 * 7.4.0 and being scored against `minimalEdits: 4`, a number counted by
 * performing the 3 -> 4 migration. See spec §15.
 */
export function scanOptionsFor(evalCase: EvalCase): ScanOptions {
  return { only: [evalCase.pkg], targets: { [evalCase.pkg]: evalCase.toVersion } };
}

export async function runCase(
  evalCase: EvalCase,
  repoDir: string,
  model: string,
  options: { useAgent?: boolean; harness?: Harness; onProgress?: (m: string) => void } = {},
): Promise<CaseOutcome> {
  const startedAt = Number(process.hrtime.bigint() / 1_000_000n);
  const base: CaseOutcome = {
    caseId: evalCase.id,
    model,
    verdict: 'unverified',
    editsApplied: 0,
    editsWithheld: 0,
    errorsBefore: 0,
    errorsAfter: 0,
    typeEscapes: 0,
    deprecationGaps: 0,
    durationMs: 0,
  };
  const elapsed = (): number => Number(process.hrtime.bigint() / 1_000_000n) - startedAt;

  try {
    const scan = await scanRepo(repoDir, scanOptionsFor(evalCase));
    const findings = scan.packages.flatMap((p) => p.findings);
    if (findings.length === 0) {
      return { ...base, durationMs: elapsed() };
    }

    const result = await fixPackage(repoDir, findings, {
      keepWorkspace: true,
      ...(options.useAgent === undefined ? {} : { useAgent: options.useAgent }),
      ...(options.harness ? { harness: options.harness } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });

    const gaps = result.workspaceDir
      ? await remainingDeprecations(findings, result.workspaceDir)
      : [];
    // Measured against the migrated tree, for the same reason the deprecation
    // gaps are: a case declares what a finished migration looks like, and only
    // the files it produced can answer whether it got there. A case that declares
    // nothing asks nothing, and a workspace that is gone could not be asked —
    // which is `unknown`, not `resolved`.
    const resolutions = evalCase.mustResolve?.length
      ? result.workspaceDir
        ? await resolveChecks(evalCase.mustResolve, result.workspaceDir)
        : evalCase.mustResolve.map((check) => ({
            check, state: 'unknown' as const, files: [], reason: 'no workspace was kept',
          }))
      : [];
    if (result.workspaceDir) await rm(result.workspaceDir, { recursive: true, force: true });

    const unresolved = resolutions.filter((r) => r.state === 'unresolved').map((r) => r.check.symbol);
    const uncheckable = resolutions
      .filter((r) => r.state === 'unknown')
      .map((r) => `${r.check.symbol} — ${r.reason ?? 'unknown'}`);

    // A refusal only makes the run inconclusive when it also failed: a harness
    // that declined on a migration the deterministic phase already fixed has not
    // invalidated anything.
    const passed =
      result.verification.outcome === 'verified' ||
      result.verification.outcome === 'typecheck-only';
    const refused = result.harness && !result.harness.ok ? result.harness.reason : undefined;

    return {
      ...base,
      verdict: result.verification.outcome,
      ...(refused && !passed ? { inconclusive: refused } : {}),
      editsApplied: result.appliedEdits,
      // From the harness, which is the only thing that writes now. It reports
      // reverted hunks rather than withheld edits — same question, and the only
      // shape there is left to ask it in.
      editsWithheld: result.harness?.revertedHunks.length ?? 0,
      ...(unresolved.length > 0 ? { unresolved } : {}),
      ...(uncheckable.length > 0 ? { uncheckable } : {}),
      typeEscapes: countTypeEscapes(result.diff),
      deprecationGaps: gaps.length,
      // Recorded from the run rather than from the request: a harness that was
      // asked for and declined — an untrusted repository, an unavailable binary
      // — did not produce these edits and must not be credited with them.
      ...(result.harness
        ? {
            harness: result.harness.id,
            harnessKept: result.harness.keptHunks,
            harnessReverted: result.harness.revertedHunks.length,
          }
        : {}),
      durationMs: elapsed(),
    };
  } catch {
    return { ...base, durationMs: elapsed() };
  }
}

/**
 * The corpus.
 *
 * Named in a file rather than discovered, because every case costs a full
 * install, migration and verification — a sweep should be something you chose to
 * pay for. The built-in default is the demo repository, which is not a corpus but
 * is enough to prove the harness runs and to catch an outright regression.
 */
export async function loadCases(file?: string): Promise<EvalCase[]> {
  if (!file) return BUILT_IN_CASES;
  const raw = await readFile(file, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? (parsed as EvalCase[]) : [];
}

export const DEMO_CASE: EvalCase = {
  id: 'zod-3.22.4-to-4.4.3',
  pkg: 'zod',
  toVersion: '4.4.3',
  repo: { kind: 'fixture', name: 'demo-repo' },
  // Five: `ZodError.errors` -> `.issues` and the `z.record` arity change, which
  // are the compile errors, plus the three deprecations — `z.string().uuid()`
  // becomes `z.uuid()`, `.email()` becomes `z.email()`, `.datetime()` becomes
  // `z.iso.datetime()`.
  //
  // This said two until a live run showed why that was wrong. Two was
  // `llm-harness.md`'s standard, where fixing a deprecation counted as editing
  // what the upgrade did not require. #2 established the opposite: a migration
  // that reports "X is deprecated", titles its commit after X and ships without
  // removing X has not done what it said. Under that standard the deprecations
  // are required, and a case that scores their absence as ideal would train the
  // agent to skip them.
  // Six. Five are code — the two compile errors and the three deprecations —
  // and the sixth is the file's doc comment, which says "Written against zod
  // 3.x. Several of the APIs used here changed in zod 4". After the migration
  // that sentence is false, and a migration that leaves a false comment behind
  // has not finished. Every run makes exactly six edits; scoring the sixth as
  // over-editing was the harness mismeasuring, not the model over-reaching.
  //
  // Six is also unreachable as a *hunk* count, which is what the pipeline
  // reports. The three deprecations are on lines 11, 12 and 14 of `schema.ts`
  // with unchanged context between them, so a perfect migration produces four
  // hunks and the sweep read it as "4 of 6" on all three runs. See §16 and
  // `minimalEdits` above: this bounds over-editing, `mustResolve` measures
  // completeness.
  minimalEdits: 6,
  // The old form in each case, never the symbol. `z.string().uuid()` becomes
  // `z.uuid()`, so a check for `.uuid` matches the *correct* answer; `z.record`
  // survives into zod 4 with a second parameter, so its presence proves nothing.
  // What is checkable is the shape the migration is supposed to remove.
  mustResolve: [
    { symbol: 'ZodError.errors', kind: 'absent', pattern: '\\.error\\.errors\\b' },
    { symbol: 'z.record/1', kind: 'absent', pattern: 'z\\.record\\(\\s*z\\.string\\(\\)\\s*\\)' },
    { symbol: 'ZodString.uuid', kind: 'absent', pattern: '\\.string\\(\\)\\s*\\.uuid\\(' },
    { symbol: 'ZodString.email', kind: 'absent', pattern: '\\.string\\(\\)\\s*\\.email\\(' },
    { symbol: 'ZodString.datetime', kind: 'absent', pattern: '\\.string\\(\\)\\s*\\.datetime\\(' },
  ],
};

/**
 * recharts 2.15.4 -> 3.10.1, the migration #1 and #2 were both written against.
 *
 * It exercises what the zod case cannot. `Cell` is a *named import*, so
 * `remainingDeprecations` can see whether the migration finished — zod's
 * deprecations are reached through call chains and are invisible to it. And the
 * only compile error is one the declaration diff never explains, so it tests
 * rule 7 rather than the change list.
 *
 * It also reproduces the narrowing trap. The tooltip formatter's value is
 * `ValueType | undefined` in 3.x, and the obvious repair — `Number(value)` —
 * renders `$NaN` for a missing value while typechecking and passing every test.
 */
export const RECHARTS_CASE: EvalCase = {
  id: 'recharts-2.15.4-to-3.10.1',
  pkg: 'recharts',
  toVersion: '3.10.1',
  repo: { kind: 'fixture', name: 'recharts-repo' },
  // Three: drop `Cell` from the import, replace the per-datum `<Cell>` children
  // with recharts 3's `fill` on the data, and narrow the tooltip formatter.
  //
  // Edit counts are chunk-sensitive — a model that rewrites the whole JSX block
  // in one find/replace reports fewer edits than one that makes the same change
  // in three, with an identical diff. The ratio is therefore a signal about
  // scope, not a precise measure, and is read alongside the deprecation and
  // escape columns rather than on its own.
  minimalEdits: 3,
  // A named import, so the check `remainingDeprecations` already performs is the
  // right one — and the reason this case is in the corpus at all.
  mustResolve: [{ symbol: 'Cell', kind: 'import', pkg: 'recharts' }],
};

/**
 * The migration the RFS is literally about: a provider changing its own client.
 *
 * openai 3 -> 4 is not a rename. `Configuration` and `OpenAIApi` both stop
 * existing, the package starts default-exporting a class, the method moves from
 * the client's own surface onto a namespace, and the response stops being
 * wrapped in an axios envelope. Nothing about that is guessable from a symbol
 * list, and none of it is a compile error until the import is fixed first —
 * which is why it is worth having in a corpus that otherwise scores
 * one-shot repairs.
 *
 * Chosen also because it installs in seconds and needs no React, so widening the
 * corpus does not mean multiplying the sweep's cost by its slowest case.
 */
export const OPENAI_CASE: EvalCase = {
  id: 'openai-3.3.0-to-4.104.0',
  pkg: 'openai',
  toVersion: '4.104.0',
  repo: { kind: 'fixture', name: 'openai-repo' },
  // Four, counted by performing the migration rather than by estimating it:
  //   1. `{ Configuration, OpenAIApi }` -> a default import
  //   2. the two-step `new Configuration(...)` / `new OpenAIApi(...)` collapses
  //      into one `new OpenAI(...)`
  //   3. `createChatCompletion(...)` -> `chat.completions.create(...)`
  //   4. `completion.data.choices` -> `completion.choices`
  //
  // The same caveat the recharts case carries applies: a model that rewrites the
  // whole module in one region reports fewer edits than one making the same
  // change in four, with an identical diff.
  //
  // Five. Four are the code edits above; the fifth is the client's doc comment,
  // which reads "`Configuration` and `OpenAIApi` are both gone in openai 4 — so
  // this import is the first thing an upgrade breaks". After the migration that
  // describes code the file no longer contains, and this corpus already settled
  // what that is worth: `DEMO_CASE` went from five to six for the same reason,
  // in the same words — a migration that leaves a false comment behind has not
  // finished.
  //
  // Said four until the diff was read rather than reasoned about. §15 pinned the
  // target and predicted this would fall to 1.0x on its own; it fell to 1.3x, so
  // the diff was captured. It holds exactly these five hunks and nothing else —
  // four from the migration, one from the review — and no over-editing at all.
  //
  // The order mattered. Recounting *before* the pin would have raised this to
  // six and encoded three unrequested major versions of openai as the standard.
  // Five is the count against 4.104.0, which is the migration the case names.
  minimalEdits: 5,
  // Both stop existing in openai 4, and both are named imports, so absence is
  // exactly what "resolved" means here — the one case where the naive reading is
  // also the correct one.
  mustResolve: [
    { symbol: 'Configuration', kind: 'import', pkg: 'openai' },
    { symbol: 'OpenAIApi', kind: 'import', pkg: 'openai' },
  ],
};

/**
 * A migration where the compiler names only half the work.
 *
 * react-query 4 -> 5 breaks the positional `useQuery(key, fn, opts)` signature
 * and renames `cacheTime` to `gcTime`; both are compile errors, and the second
 * is masked by the first until it is fixed, so this case cannot be finished in
 * one look at the diagnostics.
 *
 * `isLoading` is the interesting part and is deliberately **not scored**. It
 * still exists in v5 with a narrower meaning — `isPending` is the one that means
 * "no data yet" — so leaving it compiles, passes, and changes what the panel
 * shows on a refetch. Whether replacing it is *required* is genuinely arguable,
 * and a denominator that counts an arguable edit measures the corpus author's
 * opinion rather than the migration. It is left in the fixture because it is
 * exactly what the read-only behaviour review exists to notice, and noticing it
 * is worth watching for even when nothing scores it.
 */
export const REACT_QUERY_CASE: EvalCase = {
  id: 'react-query-4.36.1-to-5.90.2',
  pkg: '@tanstack/react-query',
  toVersion: '5.90.2',
  repo: { kind: 'fixture', name: 'react-query-repo' },
  // Two, and only the compiler-visible ones, for the reason above.
  //
  // Both land on adjacent lines, so a perfect migration is *one* hunk and the
  // sweep read this case as "1 of 2" — while the one run that scored clean is the
  // one that produced two. Doing the job exactly was penalised and doing more was
  // rewarded, which is the inversion §16 is about.
  minimalEdits: 2,
  // Neither is imported — one is a call shape and the other an option key — so
  // both are `absent` checks. `isLoading` is deliberately absent from this list
  // for the same reason it is absent from the denominator: whether replacing it
  // is *required* is genuinely arguable, and a check that encodes an arguable
  // edit measures the corpus author rather than the migration.
  mustResolve: [
    { symbol: 'useQuery/positional', kind: 'absent', pattern: 'useQuery\\(\\s*\\[' },
    { symbol: 'cacheTime', kind: 'absent', pattern: '\\bcacheTime\\s*:' },
  ],
};

export const BUILT_IN_CASES: EvalCase[] = [
  DEMO_CASE,
  RECHARTS_CASE,
  OPENAI_CASE,
  REACT_QUERY_CASE,
];

/** Put a case's repository on disk, ready to migrate. */
export async function materialiseCase(evalCase: EvalCase): Promise<string> {
  if (evalCase.repo.kind === 'local') return evalCase.repo.dir;

  const dir = await mkdtemp(path.join(tmpdir(), `emend-eval-${evalCase.id}-`));
  if (evalCase.repo.kind === 'git') {
    const { url, ref } = evalCase.repo;
    await execFileAsync('git', ['clone', '--quiet', url, dir]);
    await execFileAsync('git', ['-C', dir, 'checkout', '--quiet', ref]);
  } else {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const template = path.resolve(here, '..', 'fixtures', evalCase.repo.name);
    for (const entry of ['package.json', 'tsconfig.json', '.gitignore', 'src', 'test']) {
      await cp(path.join(template, entry), path.join(dir, entry), { recursive: true }).catch(
        () => {},
      );
    }
  }

  // Install and commit regardless of origin: the baseline has to run against a
  // real dependency tree, and the migration needs a commit to diff against.
  await execFileAsync('npm', ['install', '--no-audit', '--no-fund', '--silent'], { cwd: dir });
  await execFileAsync('git', ['-C', dir, 'init', '-q']).catch(() => {});
  await execFileAsync('git', ['-C', dir, 'add', '-A']);
  await execFileAsync('git', [
    '-C', dir, '-c', 'user.email=eval@emend.local', '-c', 'user.name=Emend Eval',
    'commit', '-q', '-m', `eval baseline: ${evalCase.id}`,
  ]).catch(() => {});
  return dir;
}

/** A fixed-width table, so two runs can be diffed by eye. */
export function renderSummary(rows: ModelSummary[]): string {
  if (rows.length === 0) return 'No results.';
  // The harness column appears only when a sweep used one, so an ordinary
  // comparison is not widened by a column of dashes.
  const escalated = rows.some((r) => r.harness);
  const lines = [
    `| Engine | Cases | Runs | Inconc. | Pass | Clean | Unresolved | Edit ratio | Withheld |${escalated ? ' Hunks kept | Hunks reverted |' : ''} Err. reduced (failed) | Escapes | Depr. gaps |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- |${escalated ? ' --- | --- |' : ''} --- | --- | --- |`,
  ];
  const pct = (n: number): string => `${Math.round(n * 100)}%`;
  for (const r of rows) {
    // Model and harness together, because together is what produced the edits.
    const engine = r.harness ? `\`${r.model}\` + \`${r.harness}\`` : `\`${r.model}\``;
    lines.push(
      `| ${engine} | ${r.casesRun}/${r.casesTotal} | ${r.runs} | ${r.inconclusive > 0 ? `**${r.inconclusive}**` : '0'} | ${pct(r.passRate)} | ${pct(r.cleanRate)} | ` +
        `${r.totalUnresolved > 0 ? `**${r.totalUnresolved}**` : '0'} | ` +
        `${r.meanEditRatio.toFixed(1)}x | ${r.totalEditsWithheld} |` +
        (escalated ? ` ${r.totalHunksKept} | ${r.totalHunksReverted} |` : '') +
        ` ${pct(r.meanErrorReduction)} | ${r.totalTypeEscapes} | ${r.totalDeprecationGaps} |`,
    );
  }
  return lines.join('\n');
}
