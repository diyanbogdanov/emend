/**
 * Measuring the agent, so that changing it is a decision rather than a hope.
 *
 * Two model comparisons have been run by hand — zod in `docs/research/llm-harness.md`
 * and recharts in the pull request that added model defaults — and neither can be
 * compared to the other or re-run to check that a later change did not regress it.
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
import { scanRepo } from './analyze.ts';
import { fixPackage } from './fix.ts';
import { countTypeEscapes } from './pr.ts';
import { remainingDeprecations } from './quality.ts';
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
    | { kind: 'demo' }
    | { kind: 'local'; dir: string }
    | { kind: 'git'; url: string; ref: string };
  /**
   * How many edits the correct migration needs.
   *
   * The denominator for over-editing. Recorded per case because it is a property
   * of the migration, not of any model: zod 3 -> 4 on the demo repository needs
   * exactly two.
   */
  minimalEdits: number;
  /** Symbols that must no longer be reachable once the migration is finished. */
  mustResolve?: string[];
}

/** What one run of one case under one model produced. */
export interface CaseOutcome {
  caseId: string;
  model: string;
  verdict: VerifyOutcome;
  editsApplied: number;
  /** Edits the evidence gate withheld — informational, never a penalty. */
  editsWithheld: number;
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
  if (!passed) penalties.push(`did not verify (${outcome.verdict})`);
  if (outcome.deprecationGaps > 0) {
    penalties.push(`${outcome.deprecationGaps} deprecation(s) reported and left in place`);
  }
  if (outcome.typeEscapes > 0) {
    penalties.push(`${outcome.typeEscapes} type escape(s) — a green build bought with \`any\``);
  }
  if (outcome.editsApplied > minimal) {
    penalties.push(
      `${outcome.editsApplied} edit(s) where ${minimal} were required (${editRatio.toFixed(1)}x)`,
    );
  }
  if (outcome.verdict === 'typecheck-only') {
    penalties.push('the tests did not run, so behaviour is unverified');
  }

  return {
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
  /** Cases this model was actually run on. */
  casesRun: number;
  /** Cases in the corpus, so a partial run is visibly partial. */
  casesTotal: number;
  passRate: number;
  cleanRate: number;
  /** Mean over runs that failed, so partial progress on hard cases stays visible. */
  meanErrorReduction: number;
  meanEditRatio: number;
  totalTypeEscapes: number;
  totalDeprecationGaps: number;
  totalDurationMs: number;
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
  const meta = new Map<string, { escapes: number; gaps: number; ms: number }>();

  for (const outcome of outcomes) {
    const evalCase = byCase.get(outcome.caseId);
    if (!evalCase) continue; // an outcome for a case no longer in the corpus
    const scores = byModel.get(outcome.model) ?? [];
    scores.push(scoreCase(evalCase, outcome));
    byModel.set(outcome.model, scores);

    const m = meta.get(outcome.model) ?? { escapes: 0, gaps: 0, ms: 0 };
    m.escapes += outcome.typeEscapes;
    m.gaps += outcome.deprecationGaps;
    m.ms += outcome.durationMs;
    meta.set(outcome.model, m);
  }

  return [...byModel.entries()]
    .map(([model, scores]) => {
      const m = meta.get(model) ?? { escapes: 0, gaps: 0, ms: 0 };
      const failed = scores.filter((s) => !s.passed);
      return {
        model,
        casesRun: scores.length,
        casesTotal: cases.length,
        passRate: scores.filter((s) => s.passed).length / scores.length,
        cleanRate: scores.filter((s) => s.clean).length / scores.length,
        // Over the failures only: a pass has nothing left to reduce, and
        // averaging its 100% in would hide how far the failures actually got.
        meanErrorReduction: mean(failed.map((s) => s.errorReduction)),
        meanEditRatio: mean(scores.filter((s) => s.passed).map((s) => s.editRatio)),
        totalTypeEscapes: m.escapes,
        totalDeprecationGaps: m.gaps,
        totalDurationMs: m.ms,
      };
    })
    .sort((a, b) => b.cleanRate - a.cleanRate || a.meanEditRatio - b.meanEditRatio);
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
export async function runCase(
  evalCase: EvalCase,
  repoDir: string,
  model: string,
  options: { useAgent?: boolean; onProgress?: (m: string) => void } = {},
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
    const scan = await scanRepo(repoDir, { only: [evalCase.pkg] });
    const findings = scan.packages.flatMap((p) => p.findings);
    if (findings.length === 0) {
      return { ...base, durationMs: elapsed() };
    }

    const result = await fixPackage(repoDir, findings, {
      keepWorkspace: true,
      ...(options.useAgent === undefined ? {} : { useAgent: options.useAgent }),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });

    const gaps = result.workspaceDir
      ? await remainingDeprecations(findings, result.workspaceDir)
      : [];
    if (result.workspaceDir) await rm(result.workspaceDir, { recursive: true, force: true });

    return {
      ...base,
      verdict: result.verification.outcome,
      editsApplied: result.appliedEdits,
      editsWithheld: (result.agent?.attempts ?? []).reduce(
        (n, a) => n + (a.droppedEdits?.length ?? 0),
        0,
      ),
      errorsBefore: result.agent?.initialErrors ?? 0,
      errorsAfter: result.agent?.finalErrors ?? 0,
      typeEscapes: countTypeEscapes(result.diff),
      deprecationGaps: gaps.length,
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
  if (!file) return [DEMO_CASE];
  const raw = await readFile(file, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? (parsed as EvalCase[]) : [];
}

export const DEMO_CASE: EvalCase = {
  id: 'zod-3.22.4-to-4.4.3',
  pkg: 'zod',
  toVersion: '4.4.3',
  repo: { kind: 'demo' },
  // `ZodError.errors` -> `.issues`, which the deterministic planner resolves, and
  // the `z.record` arity change, which it cannot. Anything beyond these two is
  // the model editing what the upgrade did not require.
  minimalEdits: 2,
  mustResolve: ['ZodError.errors', 'record'],
};

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
    const template = path.resolve(here, '..', 'fixtures', 'demo-repo');
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
  const lines = [
    '| Model | Cases | Pass | Clean | Edit ratio | Err. reduced (failed) | Escapes | Depr. gaps |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  const pct = (n: number): string => `${Math.round(n * 100)}%`;
  for (const r of rows) {
    lines.push(
      `| \`${r.model}\` | ${r.casesRun}/${r.casesTotal} | ${pct(r.passRate)} | ${pct(r.cleanRate)} | ` +
        `${r.meanEditRatio.toFixed(1)}x | ${pct(r.meanErrorReduction)} | ${r.totalTypeEscapes} | ${r.totalDeprecationGaps} |`,
    );
  }
  return lines.join('\n');
}
