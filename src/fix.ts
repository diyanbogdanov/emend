/**
 * The fix pipeline: plan -> isolated workspace -> baseline -> apply -> verify.
 *
 * Order matters. The baseline runs *before* any edit, in the same workspace, so
 * that a repository which was already red is reported as such instead of having
 * its pre-existing failures attributed to the migration.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';

import path from 'node:path';
import { fetchPackageDir } from './registry.ts';
import { extractSurface } from './surface.ts';
import { planFinding } from './plan.ts';
import { findWorkspaces } from './workspaces.ts';
import { readRepo } from './inventory.ts';
import { scanPins, resolvedVersions, planPinRepair } from './pins.ts';
import { planOverride, planRemediation, type Remediation } from './remediate.ts';
import { applyLintPatch, repairableFiles, type LintFinding } from './lint.ts';
import { readLockfile } from './lockfile.ts';
import { compareVersions } from './registry.ts';
import {
  prepareWorkspace,
  applyEdits,
  applyTextEdits,
  restoreSnapshots,
  bumpDependency,
  workspaceDiff,
  type Workspace,
} from './apply.ts';
import { runPhase, compare, verificationPassed } from './verify.ts';

import {
  asker,
  escalate,
  harnessPermitted,
  runTask,
  TIGHTENING_TASK,
  REVIEW_TASK,
  LINT_TASK,
  selectLintEdits,
  nearbySymbols,
  selectReviewEdits,
  NARROWING,
  type TextEdit,
  type EditClassification,
  type Asker,
  type Harness,
} from './harness.ts';
import type { HunkClassification } from './gate.ts';
import { reviewSession, type ReviewFinding } from './reviewharness.ts';
import {
  remainingDeprecations,
  describeDeprecationGaps,
  deprecationStillPresent,
} from './quality.ts';
import type {
  ApiSymbol,
  CommandResult,
  Finding,
  MigrationPlan,
  PinConflict,
  VerificationReport,
} from './types.ts';

const execFileAsync = promisify(execFile);

/**
 * Said when the model was wanted and could not be reached.
 *
 * Named rather than inlined at three call sites, because the wording is the
 * point: a run that fixes less than it could must say why, and "unavailable" on
 * its own leaves a reader to conclude the model tried.
 */
function unconfiguredAgent(reason: string): string {
  return `the model is on by default but unavailable: ${reason} — pass --no-agent to stop asking`;
}

export interface FixOptions {
  /** Leave the workspace on disk for inspection. */
  keepWorkspace?: boolean;
  /** Allow the LLM agent to attempt findings the deterministic planner declines. */
  useAgent?: boolean;
  /**
   * Treat the repository as untrusted: execute nothing from it or its
   * dependency tree.
   *
   * Set by the hosted service. It suppresses the test script *and* passes
   * --ignore-scripts to the dependency bump, because `npm install` runs
   * lifecycle hooks from every package it touches. Both matter: a hosted run
   * against a Prisma repository executed `prisma generate` via postinstall,
   * which is arbitrary code execution and also corrupted the verification by
   * repairing a baseline failure mid-run.
   *
   * The resulting verification is at best `typecheck-only`, which Emend already
   * refuses to report as success.
   */
  untrusted?: boolean;
  /**
   * Escalate to a harness that edits the workspace directly, when everything
   * cheaper has already failed.
   *
   * Opt-in and last, because the three costs are real and were priced
   * deliberately: latency and spend rise with multi-turn exploration,
   * reproducibility falls, and the harness becomes a dependency whose own prompt
   * changes land in this product. It buys the one thing structured edits cannot
   * do — going and reading the CI config, the Dockerfile, the build script.
   */
  harness?: Harness;
  /**
   * A read-only harness for the repo-wide review pass.
   *
   * Deliberately a second field rather than reusing `harness`. That one is
   * configured to write, and the review's entire safety argument is that it
   * cannot — sharing one handle would make "read-only" a property of how it
   * happens to be called rather than of what was passed.
   */
  reviewHarness?: Harness;
  onProgress?: (message: string) => void;
}

/** What a harness escalation did, and what the gate let through. */
export interface HarnessEscalation {
  id: string;
  ok: boolean;
  /** Why not, when `ok` is false. */
  reason?: string;
  log: string;
  keptHunks: number;
  /**
   * Hunks the current failure did not ask for, reverted before verification.
   *
   * Recorded rather than discarded, for the same reason `droppedEdits` is: a
   * reviewer is entitled to see what the harness wanted to change beyond what
   * the upgrade required.
   */
  revertedHunks: HunkClassification[];
}

export interface AgentAttempt {
  attempt: number;
  edits: TextEdit[];
  rationale: string;
  modelConfidence: string;
  outcome: string;
  error?: string;
  /**
   * Edits the current failure did not ask for, withheld before applying.
   *
   * Recorded rather than discarded: a reviewer is entitled to see what the model
   * wanted to change beyond what the upgrade required.
   */
  droppedEdits?: EditClassification[];
}

export interface FixResult {
  finding: Finding;
  plan: MigrationPlan | null;
  /** Why no plan was produced, when `plan` is null. */
  unplannableReason?: string;
  verification: VerificationReport | null;
  diff: string;
  appliedEdits: number;
  failedEdits: Array<{ file: string; line: number; reason: string }>;
  bump: CommandResult | null;
  workspaceDir: string | null;
  workspaceMode: string | null;
  /** Populated when the LLM agent was used. Kept distinct from deterministic work. */
  agent?: {
    model: string;
    provider: string;
    attempts: AgentAttempt[];
    rationale: string;
    /** Outstanding errors when the agent was handed the migration. */
    initialErrors: number;
    /** Outstanding errors when it stopped. Zero once the build passes. */
    finalErrors: number;
  };
  /** Populated when the run escalated to a harness. */
  harness?: HarnessEscalation;
  /**
   * Repo-wide review notes, when a harness was available to produce them.
   *
   * Advisory and read-only by construction: nothing here changed the diff. They
   * answer what the structured review structurally cannot — duplication against
   * code it never loaded, a shared module a caller leaked into — and so they are
   * reported to a human rather than acted on.
   */
  reviewNotes?: ReviewFinding[];
}

/**
 * Strip parameter `any` across the workspace and keep it if everything still
 * verifies. One extra verification buys back the checking wholesale; if it
 * fails, the annotations are restored and the working migration stands.
 */
async function tightenAny(
  dir: string,
  phaseOpts: { skipTests: boolean },
  baseline: Awaited<ReturnType<typeof runPhase>>,
  progress: (message: string) => void,
  /** Asks the model to repair what removing the annotations exposed. */
  tighten?: (errors: string) => Promise<number | null>,
): Promise<VerificationReport | null> {
  const { stdout } = await execFileAsync('git', [
    '-C', dir, 'diff', '--name-only', '--', '.', ':(exclude)**/node_modules/**',
  ]).catch(() => ({ stdout: '' }));

  // file -> [original, stripped, count]
  const candidates = new Map<string, [string, string, number]>();
  for (const rel of stdout.split('\n').map((l: string) => l.trim()).filter(Boolean)) {
    if (!/\.[cm]?tsx?$/.test(rel)) continue;
    const file = path.join(dir, rel);
    let before: string;
    try {
      before = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const { text, removed } = stripParameterAny(before);
    if (removed > 0) candidates.set(file, [before, text, removed]);
  }
  if (candidates.size === 0) return null;

  const total = [...candidates.values()].reduce((n, [, , c]) => n + c, 0);

  const write = async (files: Iterable<string>, stripped: boolean): Promise<void> => {
    for (const file of files) {
      const entry = candidates.get(file);
      if (entry) await writeFile(file, stripped ? entry[1] : entry[0], 'utf8');
    }
  };
  const check = async (): Promise<VerificationReport> =>
    compare(baseline, await runPhase(dir, phaseOpts));

  // Whole set first: one verification, and usually the answer.
  progress(`  tightening: removing ${total} parameter \`any\` annotation(s), re-verifying`);
  await write(candidates.keys(), true);
  let report = await check();
  if (verificationPassed(report.outcome)) {
    progress(`  tightening kept: all ${total} were unnecessary`);
    return report;
  }

  // Stripping alone recovers little, because an annotation is often hiding
  // something: `(v: any) => new Date(v as string)` compiles only while `v` is
  // `any`, and once inferred the cast is illegal. A regex cannot turn that into
  // `String(v)`, but the model can, and the compiler has just said exactly what
  // is wrong. So ask — with the annotations already removed and re-adding them
  // ruled out.
  if (tighten) {
    const repaired = await tighten(verificationErrors(report));
    if (repaired) {
      const after = await check();
      if (verificationPassed(after.outcome)) {
        progress(`  tightening kept: all ${total} removed, ${repaired} follow-up edit(s)`);
        return after;
      }
      // The follow-up did not work; fall through to the per-file pass from the
      // stripped-but-unrepaired state.
      progress('  tightening: repair did not verify, falling back to file by file');
      await write(candidates.keys(), true);
    }
  }

  // One load-bearing annotation should not cost the other fifteen. Restore
  // everything, then re-strip file by file and keep whatever still verifies.
  // Each file costs a verification, so this is bounded rather than exhaustive.
  const perFileBudget = 10;
  const files = [...candidates.keys()].slice(0, perFileBudget);
  const skipped = candidates.size - files.length;
  progress(
    `  tightening: whole set was load-bearing, retrying file by file` +
      (skipped > 0 ? ` (${skipped} file(s) beyond the budget keep theirs)` : ''),
  );
  await write(candidates.keys(), false);

  const keptFiles: string[] = [];
  let keptCount = 0;
  let best: VerificationReport | null = null;
  for (const file of files) {
    await write([file], true);
    const trial = await check();
    if (verificationPassed(trial.outcome)) {
      keptFiles.push(file);
      keptCount += candidates.get(file)?.[2] ?? 0;
      best = trial;
    } else {
      await write([file], false);
    }
  }

  if (keptFiles.length === 0) {
    progress('  tightening reverted: every annotation was load-bearing');
    return null;
  }
  progress(
    `  tightening kept: ${keptCount} of ${total} annotation(s) removed across ` +
      `${keptFiles.length} file(s); the rest were load-bearing`,
  );
  return best;
}

/**
 * The repair `tightenAny` asks for: show the model the compiler's complaints
 * against the already-stripped sources, and apply whatever it proposes.
 *
 * Each way this can come to nothing is reported separately. They used to share
 * one `return null`, so a repair that proposed no edits looked exactly like one
 * whose edits all failed to apply, and the run reported neither.
 */
async function repairTightening(
  asker: Asker,
  dir: string,
  finding: Finding,
  extraFiles: string[],
  progress: (message: string) => void,
  errors: string,
): Promise<number | null> {
  const proposal = await runTask(asker, TIGHTENING_TASK, {
    finding,
    // Re-read: the files on disk are the stripped ones, not what the migration
    // was shown, and the prompt promises the model exactly what it is holding.
    sources: await loadSources(dir, finding, extraFiles),
    errors,
  });
  if (!proposal.ok) {
    progress(`    tightening repair unavailable: ${proposal.error ?? 'unknown error'}`);
    return null;
  }
  if (proposal.edits.length === 0) {
    progress(
      `    tightening repair proposed no edits: ${proposal.rationale || 'no rationale given'}`,
    );
    return null;
  }
  const applied = await applyTextEdits(dir, proposal.edits);
  if (applied.applied.length === 0) {
    progress(`    tightening repair: none of ${proposal.edits.length} edit(s) matched the source`);
    return null;
  }
  progress(
    `    tightening repair: applied ${applied.applied.length} of ${proposal.edits.length} edit(s)`,
  );
  return applied.applied.length;
}

/**
 * Review the green migration, keeping the review's edits only if it stays green.
 *
 * Same shape as `tightenAny`, because that shape is proven: the model may
 * restructure freely since the compiler and the tests decide whether it was
 * right, and a snapshot puts the migration back when it was not.
 *
 * One attempt. The migration already works, so everything here is upside —
 * spending three verifications chasing a nicer diff is the wrong trade.
 */
async function reviewMigration(
  asker: Asker,
  ws: Workspace,
  phaseOpts: { skipTests: boolean },
  baseline: Awaited<ReturnType<typeof runPhase>>,
  finding: Finding,
  findings: Finding[],
  extraFiles: string[],
  candidateSymbols: string[],
  progress: (message: string) => void,
  // The kept edit count travels back with the report. Without it the review's
  // work is invisible to `appliedEdits`, and a migration that landed five edits
  // reports two — which is exactly what the first eval sweep measured.
): Promise<{ report: VerificationReport; applied: number } | null> {
  // Measured before the model is asked. A migration can report "X is deprecated"
  // and ship without removing one use of X — that happened, on a pull request
  // titled "migrate `Cell`" that removed no use of `Cell` — and no phase of
  // verification objects, because deprecated code compiles and its tests pass.
  const gaps = await remainingDeprecations(findings, ws.dir);
  if (gaps.length > 0) {
    progress(`  review: ${gaps.length} deprecation(s) not finished by the migration`);
  }

  // The migration's own diff, which is both what the review is asked to judge
  // and — below — the boundary of what it may change.
  const migrationDiff = await workspaceDiff(ws);
  const sources = await loadSources(ws.dir, finding, extraFiles);
  const proposal = await runTask(asker, REVIEW_TASK, {
    finding,
    sources,
    diff: migrationDiff,
    deprecationGaps: describeDeprecationGaps(gaps),
    candidateSymbols,
  });

  if (!proposal.ok) {
    progress(`    review unavailable: ${proposal.error ?? 'unknown error'}`);
    return null;
  }
  if (proposal.edits.length === 0) {
    progress(`    review found nothing to change: ${proposal.rationale.slice(0, 160)}`);
    return null;
  }
  // The review's evidence gate. Every other stage has one; this was the gap, and
  // it showed on a live run — an unanchored review rewrote a working
  // `cancelToken` into an `AbortSignal`, changing an exported signature to
  // modernise an API carrying no deprecation marker. Green build, cleared
  // advisory, nothing downstream objected, because an unnecessary edit that
  // compiles and passes is invisible to verification precisely by being right.
  //
  // Anchors: what the migration changed, plus the call sites of deprecations it
  // reported and did not finish. Rule 4 outranks rule 6, so that repair stays in
  // scope wherever it lives.
  const stillDeprecated = new Set(gaps.map((g) => g.symbol));
  const deprecatedSites = findings
    .filter(
      (f) =>
        f.change.kind === 'deprecated' &&
        stillDeprecated.has(f.change.path.split('.').pop() ?? f.change.path),
    )
    .flatMap((f) => f.sites.map((s) => ({ file: s.file, line: s.line })));

  const { keep, dropped } = selectReviewEdits(
    proposal.edits,
    migrationDiff,
    deprecatedSites,
    sources,
  );
  if (dropped.length > 0) {
    progress(`    review: withheld ${dropped.length} edit(s) outside the migration's diff`);
  }
  if (keep.length === 0) {
    progress(`    review: nothing in scope of ${proposal.edits.length} proposed edit(s)`);
    return null;
  }

  const applied = await applyTextEdits(ws.dir, keep);
  if (applied.applied.length === 0) {
    progress(`    review: none of ${keep.length} edit(s) matched the source`);
    return null;
  }
  progress(`    review: applied ${applied.applied.length} of ${keep.length} edit(s)`);

  const report = compare(baseline, await runPhase(ws.dir, phaseOpts));
  if (verificationPassed(report.outcome)) {
    progress(`  review kept: ${applied.applied.length} edit(s), still ${report.outcome}`);
    return { report, applied: applied.applied.length };
  }

  // The review broke it. The migration was already good; discard the opinion.
  progress(`  review reverted: did not verify (${report.outcome})`);
  await restoreSnapshots(ws.dir, applied.snapshots);
  return null;
}

/**
 * Recompute the target version's symbol table.
 *
 * The scan stores only consumer-impacting changes, but the planner needs the full
 * set of symbols in the new version to find a replacement. Tarballs are cached,
 * so recomputing is cheaper and less error-prone than persisting a large
 * denormalised blob alongside every finding.
 */
async function targetSymbols(finding: Finding): Promise<Record<string, ApiSymbol>> {
  const toDir = await fetchPackageDir(finding.pkg, finding.toVersion);
  const toSurface = await extractSurface(toDir, finding.pkg, finding.toVersion);
  return toSurface.symbols;
}


/**
 * Symbols from the new version that the compiler's own error text mentions.
 *
 * A type error names the types it is about — `Formatter`, `ValueType`,
 * `TooltipPayloadEntry` — and those are usually exported, sometimes under a
 * different name (`ValueType` ships as `TooltipValueType`). Matching them here
 * puts the vocabulary of the error into the model's list of usable symbols,
 * which is the difference between annotating the real constraint and reaching
 * for `any`.
 */
/**
 * Symbols the compiler says are gone, as opposed to symbols it merely names.
 *
 * The candidate list is ranked by similarity to whatever broke. Drift findings
 * supply that; a vulnerability repair has none, so the compiler output is the
 * only source — and `symbolsNamedInErrors` cannot help, because it matches names
 * against the *new* version's symbols and a removed one matches nothing.
 *
 * Measured live: axios 0.33.0 removes `AxiosTransformer`, tsc says so and
 * suggests only a default import, and `AxiosResponseTransformer` — which axios
 * exports and is the actual replacement — never reached the prompt. The agent
 * dropped the annotation rather than name a type it had not been shown.
 *
 * Only errors that mean *this identifier no longer exists*. An arity or
 * assignability error is about a symbol that is still there, and ranking the
 * list by similarity to it would be worse than not ranking it at all.
 */
const GONE = [
  /has no exported member '([^']+)'/g,
  /Cannot find name '([^']+)'/g,
  /Property '([^']+)' does not exist on type/g,
];

export function missingSymbols(errors: string): string[] {
  const found = new Set<string>();
  for (const pattern of GONE) {
    for (const match of errors.matchAll(pattern)) {
      if (match[1]) found.add(match[1]);
    }
  }
  return [...found];
}


/**
 * Remove `any` annotations that were never needed.
 *
 * A migration that reaches green with `(value: any)` has satisfied every gate
 * the pipeline has, because `any` compiles exactly as well as a correct type.
 * Asking the model not to do it does not work — told to prefer the stronger
 * form and given the exported type to use, it produced twelve `any`
 * annotations anyway. The model optimises for what is measured, so this
 * measures it.
 *
 * Deleting a parameter annotation does not weaken anything: TypeScript infers
 * the parameter from the contextual type, which is the real contract. So
 * `(value: any) => …` becomes `(value) => …` and the compiler decides whether
 * that was load-bearing. Anything that still compiles was `any` for no reason.
 *
 * Scoped to parameter positions on purpose. Removing `const x: any = …` changes
 * what is inferred rather than recovering it.
 */
export function stripParameterAny(source: string): { text: string; removed: number } {
  let removed = 0;
  const text = source.replace(/([(,]\s*\.{0,3}\w+\??)\s*:\s*any\b(?!\[)/g, (_m, keep: string) => {
    removed++;
    return keep;
  });
  return { text, removed };
}

/** Collect the sources the agent needs to reason about, capped to stay in context. */
async function loadSources(
  repoDir: string,
  finding: Finding,
  extraFiles: string[] = [],
): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  const callSiteFiles = [...new Set(finding.sites.map((s) => s.file))].slice(0, 6);
  // package.json is always relevant: this is a dependency migration, and the
  // version range being changed lives there. Repositories assert against it
  // (Docker base image tags, engine constraints) and the agent cannot reason
  // about those without seeing it.
  const files = [
    ...new Set(['package.json', ...callSiteFiles, ...extraFiles]),
  ].slice(0, 24);
  for (const file of files) {
    try {
      const content = await readFile(path.join(repoDir, file), 'utf8');
      sources.set(file, content.length > 60_000 ? content.slice(0, 60_000) : content);
    } catch {
      /* unreadable file: the agent simply will not see it */
    }
  }
  return sources;
}

/**
 * Most files pulled in because a failure named them.
 *
 * A wide upgrade breaks many files at once — recharts 2 to 3 produces fourteen
 * errors across ten files in a private monorepo — and a model shown two of them
 * cannot produce a coherent migration.
 */
const MAX_COLLATERAL_FILES = 16;

/**
 * Repository files named by compiler or test output.
 *
 * An upgrade can break a file that contains no call site at all. a scanned repository
 * asserts its Dockerfile's Playwright image tag matches package.json, so bumping
 * the dependency fails a test in a file the call-site walk never visits — and
 * the agent, shown only call-site files, correctly declined because it could not
 * see what was wrong. Feeding it the files the failure actually names closes
 * that gap without guessing at what else might be relevant.
 */
async function filesNamedInOutput(output: string, repoDir: string): Promise<string[]> {
  const found = new Set<string>();

  // A workspace repository's compiler prints paths relative to the *workspace*,
  // not the repository root: `@acme/web typecheck: src/components/X.tsx(40,11)`
  // means packages/web/src/components/X.tsx. Resolving only against the root
  // finds none of them, so the model was handed a failure it had no files for
  // and correctly declined to guess.
  const bases = ['', ...(await findWorkspaces(repoDir))];

  // Route-group and dynamic-segment directories — `(dashboard)`, `[promptId]` —
  // are ordinary in Next.js apps and were excluded by the path character class.
  const pattern =
    /(?:^|[\s'"])((?:[\w.@()\[\]+-]+\/)*(?:[\w.@()\[\]+-]+\.(?:[cm]?tsx?|[cm]?jsx?|json|ya?ml)|Dockerfile[\w.-]*|Makefile))(?=[\s:(,'"]|$)/gm;

  let m: RegExpExecArray | null;
  while ((m = pattern.exec(output)) !== null) {
    const rel = m[1];
    if (!rel) continue;
    if (rel.startsWith('node_modules/') || rel.includes('/node_modules/')) continue;
    for (const base of bases) {
      const candidate = base ? `${base}/${rel}` : rel;
      if (existsSync(path.join(repoDir, candidate))) {
        found.add(candidate);
        break;
      }
    }
    if (found.size >= MAX_COLLATERAL_FILES) break;
  }
  return [...found];
}



function verificationErrors(report: VerificationReport): string {
  const parts: string[] = [];
  for (const [label, r] of [
    ['typecheck', report.post.typecheck],
    ['test', report.post.test],
  ] as const) {
    if (r.skipped || r.ok) continue;
    parts.push(`--- ${label} (${r.command}) ---`);
    // Generous, because this text is the specification the model works from and
    // it is also where the list of broken files comes from. recharts 2 to 3
    // emits fourteen errors averaging 400 characters; a 3000-character tail
    // showed two of the ten affected files, and the model — correctly — refused
    // to migrate a failure it could only partly see.
    if (r.stdout.trim()) parts.push(r.stdout.trim().slice(-40_000));
    if (r.stderr.trim()) parts.push(r.stderr.trim().slice(-40_000));
  }
  return parts.join('\n') || 'verification failed with no captured output';
}

/**
 * Fix every finding for one package in a single workspace.
 *
 * A version bump is atomic: you cannot upgrade zod to 4.x and address only one
 * of the breaks it introduces. Fixing findings in separate workspaces makes each
 * one look like a regression (because it is — alone, it is insufficient) and
 * would produce conflicting PRs that each fail CI.
 *
 * So the unit of work is the package upgrade, not the individual finding.
 */

export async function fixPackage(
  repoDir: string,
  findings: Finding[],
  options: FixOptions = {},
): Promise<PackageFixResult> {
  const progress = options.onProgress ?? (() => {});
  const first = findings[0];
  if (!first) throw new Error('fixPackage requires at least one finding');

  const pkg = first.pkg;
  const toVersion = first.toVersion;
  const fromVersion = first.fromVersion;

  progress(`planning ${findings.length} finding(s) for ${pkg}`);
  const toSymbols = await targetSymbols(first);

  const planned: Array<{ finding: Finding; plan: MigrationPlan }> = [];
  const unplanned: Finding[] = [];
  for (const f of findings) {
    const plan = planFinding(f, toSymbols);
    if (plan) planned.push({ finding: f, plan });
    else unplanned.push(f);
  }
  progress(`  ${planned.length} deterministic, ${unplanned.length} needing an agent or a human`);

  const llm = asker({ disabled: options.useAgent !== true });
  // Wanting the agent and silently not getting one is the worst of both: the
  // run looks like the model tried and failed, when it never ran at all.
  if (!llm.ok && llm.why === 'unconfigured') progress(unconfiguredAgent(llm.reason));

  let ws: Workspace | null = null;
  try {
    ws = await prepareWorkspace(repoDir);
    progress(`  workspace: ${ws.dir} (${ws.mode})`);

    progress('running baseline verification (before any change)');
    const untrusted = options.untrusted === true;
    const phaseOpts = { skipTests: untrusted };
    const baseline = await runPhase(ws.dir, phaseOpts);
    progress(
      `  baseline: typecheck=${describe(baseline.typecheck)} test=${describe(baseline.test)}`,
    );

    progress(`bumping ${pkg} ${fromVersion} -> ${toVersion}`);
    const bump = await bumpDependency(ws.dir, pkg, toVersion, {
      ignoreScripts: untrusted,
    });

    let appliedCount = 0;
    const failedEdits: Array<{ file: string; line: number; reason: string }> = [];

    for (const { plan } of planned) {
      const res = await applyEdits(ws.dir, plan.edits);
      appliedCount += res.applied.length;
      for (const f of res.failed) {
        failedEdits.push({ file: f.edit.file, line: f.edit.line, reason: f.reason });
      }
    }
    if (planned.length > 0) {
      progress(`applied ${appliedCount} deterministic edit(s)`);
    }

    progress('running verification after deterministic edits');
    let post = await runPhase(ws.dir, phaseOpts);
    let verification = compare(baseline, post);
    progress(`  ${verification.outcome}`);

    // Every call site across the upgrade, under the first finding's package and
    // version. A bump is atomic, so both the agent and the harness gate reason
    // about the whole of it rather than one finding at a time.
    const agentFinding = { ...first, sites: findings.flatMap((f) => f.sites) };

    // Escalate to the agent only if deterministic work was not enough. The
    // remaining errors are exactly the context the model needs.
    // Polish, once the migration is green. Repair itself is no longer Emend's
    // job — an agent driving the MCP tools has edit rights and a loop of its
    // own, and `runAgentRepair` was 270 lines reimplementing that badly with a
    // fixed three-attempt budget.
    //
    // What survived the deletion is the work that loop did *besides* retrying:
    // finding which files a failure actually implicates, and grounding a
    // replacement in symbols the target version really exports. Both are still
    // needed here, so both now come from the workspace diff rather than being
    // threaded out of a repair.
    const agentRecord: FixResult['agent'] = undefined;
    if (llm.ok && verificationPassed(verification.outcome)) {
      const config = llm.asker;
      const dir = ws.dir;
      const diffSoFar = await workspaceDiff(ws);
      const extraFiles = await filesNamedInOutput(diffSoFar, dir);

      // Interleaved per finding, as before: concatenating means the prompt's
      // cutoff falls inside the first finding's list, so with nine broken
      // symbols the model never sees a replacement for eight of them.
      const ranked = findings.map((f) => nearbySymbols(f.change.path, toSymbols));
      const candidates: string[] = [];
      const seen = new Set<string>();
      for (let k = 0; k < Math.max(0, ...ranked.map((r) => r.length)); k++) {
        for (const list of ranked) {
          const symbol = list[k];
          if (symbol !== undefined && !seen.has(symbol)) {
            seen.add(symbol);
            candidates.push(symbol);
          }
        }
      }

      const tightened = await tightenAny(dir, phaseOpts, baseline, progress, (errors) =>
        repairTightening(config, dir, agentFinding, extraFiles, progress, errors),
      );
      if (tightened) verification = tightened;

      // Green, and now: is it worth merging? Verification cannot answer that.
      const reviewed = await reviewMigration(
        config, ws, phaseOpts, baseline, agentFinding, findings,
        extraFiles, candidates, progress,
      );
      if (reviewed) {
        verification = reviewed.report;
        appliedCount += reviewed.applied;
      }
    }

    // Last resort. Structured edits have had their retries and the build is
    // still red, so what remains is the class of change they cannot express:
    // something outside the call sites Emend found, in a file it never loaded.
    let harnessRecord: HarnessEscalation | undefined;
    if (
      options.harness &&
      verification.outcome !== 'verified' &&
      verification.outcome !== 'typecheck-only'
    ) {
      const harness = options.harness;
      const permitted = harnessPermitted({ untrusted });
      if (!permitted.ok) {
        progress(`declining to escalate to ${harness.id}: ${permitted.reason}`);
        harnessRecord = {
          id: harness.id,
          ok: false,
          reason: permitted.reason,
          log: '',
          keptHunks: 0,
          revertedHunks: [],
        };
      } else {
        progress(`escalating to ${harness.id}`);
        const failureOutput = verificationErrors(verification);

        // A deprecated call compiles, so it never produces a diagnostic and a
        // hunk over it would be judged unrequested and reverted — cancelling
        // exactly the repair the finding asked for. The carve-out the edit gate
        // already has, applied to the same question in a different shape.
        const sources = await loadSources(ws.dir, agentFinding, []);
        const stillDeprecated = new Set(
          findings
            .filter((f) => f.change.kind === 'deprecated')
            .filter((f) =>
              f.sites.some((s) => {
                const source = sources.get(s.file);
                return source ? deprecationStillPresent(f.change.path, pkg, source) : false;
              }),
            )
            .map((f) => f.change.path),
        );

        const escalation = await escalate(
          harness,
          ws.dir,
          {
            instruction:
              `The dependency ${pkg} was upgraded from ${fromVersion} to ${toVersion} in this ` +
              `repository, and the build no longer succeeds. Make the smallest set of changes ` +
              `that gets it building and passing its own tests again.\n\n` +
              `Change nothing the upgrade does not require. No new features, no reformatting, ` +
              `no refactoring of code that already works.\n\n${NARROWING.text}`,
            failureOutput,
          },
          {
            changes: findings.map((f) => ({ change: f.change, sites: f.sites })),
            failureOutput,
            unresolvedDeprecations: stillDeprecated,
          },
        );

        harnessRecord = {
          id: harness.id,
          ok: escalation.ok,
          log: escalation.log,
          keptHunks: escalation.keptHunks,
          revertedHunks: escalation.revertedHunks,
          ...(escalation.reason ? { reason: escalation.reason } : {}),
        };

        if (!escalation.ok) {
          progress(`  ${escalation.reason}`);
        } else {
          if (escalation.revertedHunks.length > 0) {
            progress(
              `  reverted ${escalation.revertedHunks.length} hunk(s) no diagnostic asked for`,
            );
          }
          progress(`  ${escalation.keptHunks} hunk(s) kept, re-verifying`);
          post = await runPhase(ws.dir, phaseOpts);
          verification = compare(baseline, post);
          progress(`  verification: ${verification.outcome}`);
        }
      }
    }

    const diff = await workspaceDiff(ws);

    // The repo-wide review. Only on a migration that stands: reviewing a diff
    // that does not verify tells a reader about code that is not going to ship,
    // and spends the most expensive step in the pipeline doing it.
    let reviewNotes: ReviewFinding[] | undefined;
    if (options.reviewHarness && verificationPassed(verification.outcome)) {
      const review = await reviewSession({
        harness: options.reviewHarness,
        dir: ws.dir,
        pkg, fromVersion, toVersion, diff,
        progress,
      });
      if (review.findings.length > 0) reviewNotes = review.findings;
    }

    const result: PackageFixResult = {
      pkg,
      fromVersion,
      toVersion,
      findings,
      plans: planned.map((p) => p.plan),
      unplanned,
      verification,
      diff,
      appliedEdits: appliedCount,
      failedEdits,
      bump,
      workspaceDir: ws.dir,
      workspaceMode: ws.mode,
      ...(agentRecord ? { agent: agentRecord } : {}),
      ...(harnessRecord ? { harness: harnessRecord } : {}),
      ...(reviewNotes ? { reviewNotes } : {}),
    };

    if (!options.keepWorkspace) {
      await ws.cleanup();
      result.workspaceDir = null;
    }
    return result;
  } catch (err) {
    if (ws && !options.keepWorkspace) await ws.cleanup().catch(() => {});
    throw err;
  }
}

export interface PinFixResult {
  conflicts: PinConflict[];
  /** Conflicts with an authority, which are the only ones that can be repaired. */
  repairable: number;
  verification: VerificationReport;
  diff: string;
  appliedEdits: number;
  failedEdits: Array<{ file: string; reason: string }>;
  workspaceDir: string | null;
  workspaceMode: string | null;
}

/**
 * Bring drifted version pins back in line, and prove the build still works.
 *
 * Its own pipeline rather than a step inside `fixPackage`, because the unit of
 * work is different: a pin conflict belongs to the repository, not to any
 * package upgrade, and there is no dependency bump involved. What it shares is
 * the part that matters — an isolated worktree, a baseline taken before any
 * edit, and a verdict that distinguishes a repository this change broke from one
 * that was already red.
 *
 * No model is involved at any point.
 */
export async function fixPins(
  repoDir: string,
  options: FixOptions = {},
): Promise<PinFixResult> {
  const progress = options.onProgress ?? (() => {});
  const untrusted = options.untrusted === true;
  const phaseOpts = { skipTests: untrusted };

  const repo = await readRepo(repoDir);
  const { conflicts } = await scanPins(resolvedVersions(repo.dependencies), async (file) => {
    try {
      return await readFile(path.join(repoDir, file), 'utf8');
    } catch {
      return null;
    }
  });

  const edits = conflicts.flatMap((c) => planPinRepair(c));
  const repairable = conflicts.filter((c) => c.expected !== null).length;
  progress(`${conflicts.length} pin conflict(s), ${repairable} with an authority to repair against`);

  let ws: Workspace | null = null;
  try {
    ws = await prepareWorkspace(repoDir);
    progress(`  workspace: ${ws.dir} (${ws.mode})`);

    progress('running baseline verification (before any change)');
    const baseline = await runPhase(ws.dir, phaseOpts);

    const applied = await applyTextEdits(
      ws.dir,
      edits.map((e) => ({ file: e.file, find: e.find, replace: e.replace, reason: e.reason })),
    );
    progress(`applied ${applied.applied.length} pin edit(s), ${applied.failed.length} rejected`);

    const verification = compare(baseline, await runPhase(ws.dir, phaseOpts));
    progress(`  ${verification.outcome}`);

    const result: PinFixResult = {
      conflicts,
      repairable,
      verification,
      diff: await workspaceDiff(ws),
      appliedEdits: applied.applied.length,
      failedEdits: applied.failed.map((f) => ({ file: f.edit.file, reason: f.reason })),
      workspaceDir: ws.dir,
      workspaceMode: ws.mode,
    };
    if (!options.keepWorkspace) {
      await ws.cleanup();
      result.workspaceDir = null;
    }
    return result;
  } catch (err) {
    if (ws && !options.keepWorkspace) await ws.cleanup().catch(() => {});
    throw err;
  }
}

export interface PackageFixResult {
  pkg: string;
  fromVersion: string;
  toVersion: string;
  findings: Finding[];
  plans: MigrationPlan[];
  /** Findings with no deterministic plan — needing an agent or a human. */
  unplanned: Finding[];
  verification: VerificationReport;
  diff: string;
  appliedEdits: number;
  failedEdits: Array<{ file: string; line: number; reason: string }>;
  bump: CommandResult | null;
  workspaceDir: string | null;
  workspaceMode: string | null;
  agent?: FixResult['agent'];
  /** Present only when a harness was configured and the build was still red. */
  harness?: HarnessEscalation;
}

/**
 * Fix a single finding.
 *
 * Delegates to `fixPackage` with a one-element list rather than reimplementing
 * the pipeline. It previously did the latter, and the two copies drifted: the
 * agent escalation in `fixPackage` learned to include package.json and the
 * files a failure names, while this path did not, so `emend pr --agent`
 * rendered "unverified, needs a human" for a migration that `emend fix --agent`
 * had just verified.
 *
 * Note that a version bump is atomic. Fixing one finding of several still bumps
 * the dependency, so the other findings' breakage is present and verification
 * will fail. This is only appropriate when the package has one finding, or for
 * rendering a single finding's evidence.
 */
/**
 * Whether a finding can only be repaired by editing source.
 *
 * `Finding.pkg` carries whatever its detector is about, and for `http-contract`
 * that is a host — `api.github.com`. The package path took it for a package
 * name and asked npm for it, which 404s; the same shape `version-pin` is
 * already routed away from, because `npm install node@22` is nonsense too.
 *
 * There is no version to bump for a wire API. The description is the target and
 * the repair is an edit at the call sites, so this belongs to the agent rather
 * than to the registry.
 */
export function needsSourceRepair(finding: Finding): boolean {
  return finding.detector === 'http-contract';
}

export async function fixFinding(
  repoDir: string,
  finding: Finding,
  options: FixOptions = {},
): Promise<FixResult> {
  const pkgResult = await fixPackage(repoDir, [finding], options);
  const plan = pkgResult.plans[0] ?? null;

  const deterministicReason =
    finding.change.kind === 'deprecated'
      ? 'symbol is deprecated but still present; no mechanical replacement is derivable from the type surface alone'
      : 'no unambiguous replacement symbol with a matching signature was found \u2014 Emend will not guess';

  return {
    finding,
    plan,
    ...(plan ? {} : { unplannableReason: deterministicReason }),
    verification: pkgResult.verification,
    diff: pkgResult.diff,
    appliedEdits: pkgResult.appliedEdits,
    failedEdits: pkgResult.failedEdits,
    bump: pkgResult.bump,
    workspaceDir: pkgResult.workspaceDir,
    workspaceMode: pkgResult.workspaceMode,
    ...(pkgResult.agent ? { agent: pkgResult.agent } : {}),
    ...(pkgResult.harness ? { harness: pkgResult.harness } : {}),
  };
}

function describe(r: CommandResult): string {
  if (r.skipped) return `skipped(${r.skipReason})`;
  return r.ok ? 'pass' : `FAIL(exit ${r.exitCode})`;
}

export interface VulnFixResult {
  finding: Finding;
  /** Which rung was tried, and why none was when that is the answer. */
  remediation: Remediation;
  /** Whether the vulnerable version actually left the tree. */
  resolved: boolean;
  /** True when an override was needed, because no bump would move it. */
  overrode: boolean;
  /** What the package resolves to now, read back from the lockfile. */
  installedAfter: string | null;
  verification: VerificationReport | null;
  diff: string;
  workspaceDir: string | null;
  workspaceMode: string | null;
  /** Advisory notes from the read-only repo-wide pass, when one ran. */
  reviewNotes?: ReviewFinding[];
  /**
   * Populated when the bump cleared the advisory but broke the build, and the
   * agent was asked to repair it. Absent means no repair was attempted — which
   * is the answer whenever the advisory did *not* clear.
   */
  agent?: FixResult['agent'];
  note?: string;
}

/**
 * Get a vulnerable package out of the installed tree, and prove the build survives.
 *
 * Two questions, and both have to be answered. *Did the vulnerable version
 * leave?* is read back from the lockfile after installing — never predicted,
 * because predicting npm's resolution is a worse job than doing it and looking.
 * *Does the repository still work?* is the ordinary baseline comparison every
 * other repair here goes through.
 *
 * A bump that verifies green but leaves the vulnerable version installed is not
 * a fix, and reporting it as one would be the most expensive kind of false
 * certainty this product can produce.
 */
/**
 * Whether a red build after a security bump is worth handing to the agent.
 *
 * Both halves matter, and the second is the dangerous one. Repairing a build
 * whose bump did *not* clear the advisory produces a green build with the
 * vulnerable version still installed — which `fixVulnerability`'s own note calls
 * the failure most easily mistaken for success. Making it compile would remove
 * the last signal that anything is wrong.
 */
export function repairableAfterBump(state: {
  resolved: boolean;
  outcome: VerificationReport['outcome'];
}): boolean {
  return state.resolved && !verificationPassed(state.outcome);
}

export async function fixVulnerability(
  repoDir: string,
  finding: Finding,
  options: FixOptions = {},
): Promise<VulnFixResult> {
  const progress = options.onProgress ?? (() => {});
  const untrusted = options.untrusted === true;
  const phaseOpts = { skipTests: untrusted };

  const repo = await readRepo(repoDir);
  const directs = new Set(repo.dependencies.map((d) => d.name));
  const lockRaw = await readFile(path.join(repoDir, 'package-lock.json'), 'utf8').catch(() => '');
  const target = finding.toVersion === finding.fromVersion ? null : finding.toVersion;
  const remediation = planRemediation(
    { name: finding.pkg, version: finding.fromVersion, target },
    directs,
    lockRaw,
  );

  const base = {
    finding,
    remediation,
    resolved: false,
    overrode: false,
    installedAfter: null,
    verification: null,
    diff: '',
    workspaceDir: null,
    workspaceMode: null,
  } satisfies VulnFixResult;

  if (remediation.kind === 'none') {
    progress(`no bump available: ${remediation.reason}`);
    return { ...base, note: remediation.reason };
  }

  let ws: Workspace | null = null;
  try {
    ws = await prepareWorkspace(repoDir);
    progress(`  workspace: ${ws.dir} (${ws.mode})`);
    progress('running baseline verification (before any change)');
    const baseline = await runPhase(ws.dir, phaseOpts);

    if (remediation.kind === 'direct') {
      progress(`bumping ${remediation.pkg} to ${remediation.to}`);
      await bumpDependency(ws.dir, remediation.pkg, remediation.to, { ignoreScripts: untrusted });
    } else {
      // Every direct dependency whose tree reaches it, because any one of them
      // can be the reason the old version is still resolved.
      progress(
        `bumping ${remediation.parents.join(', ')} to move ${remediation.child} to ${remediation.to}`,
      );
      for (const parent of remediation.parents) {
        await bumpDependency(ws.dir, parent, 'latest', { ignoreScripts: untrusted });
      }
    }

    // Read back rather than assume. A parent bump may resolve a patched child,
    // a still-vulnerable one, or the same one — and only the lockfile knows.
    const stillAffected = async (): Promise<{ versions: string[]; worst: string | null }> => {
      const after = await readLockfile(ws!.dir);
      const versions = [...after.tree.values()]
        .filter((e) => e.name === finding.pkg)
        .map((e) => e.version)
        .sort(compareVersions);
      return { versions, worst: versions[0] ?? null };
    };
    const cleared = (worst: string | null, count: number): boolean =>
      count === 0 || (worst !== null && compareVersions(worst, finding.toVersion) >= 0);

    let { versions: installed, worst } = await stillAffected();
    progress(
      installed.length === 0
        ? `  ${finding.pkg} is no longer installed`
        : `  ${finding.pkg} now resolves to ${installed.join(', ')}`,
    );

    // Rung three. A bump that did not move it means no dependency's own range
    // selects a patched version, so the only remaining lever is to force one —
    // which tells npm to override a constraint a parent declared deliberately.
    // The parent may genuinely break, and that is what the verification below
    // is for.
    let overrode = false;
    if (!cleared(worst, installed.length)) {
      const manifestPath = path.join(ws.dir, 'package.json');
      const manifestRaw = await readFile(manifestPath, 'utf8').catch(() => '');
      const edit = planOverride(manifestRaw, finding.pkg, finding.toVersion);
      if (edit) {
        progress(`  the bump did not move it; forcing ${finding.pkg} to ${finding.toVersion}`);
        const applied = await applyTextEdits(ws.dir, [edit]);
        if (applied.applied.length > 0) {
          overrode = true;
          await bumpDependency(ws.dir, finding.pkg, finding.toVersion, {
            ignoreScripts: untrusted,
          }).catch(() => null);
          ({ versions: installed, worst } = await stillAffected());
          progress(`  ${finding.pkg} now resolves to ${installed.join(', ') || '(absent)'}`);
        }
      }
    }
    const resolved = cleared(worst, installed.length);

    let post = await runPhase(ws.dir, phaseOpts);
    let verification = compare(baseline, post);
    progress(`  ${verification.outcome}`);

    // No repair here. The advisory clearing and the build breaking are reported
    // as the two separate facts they are, and repairing the break belongs to
    // whoever called this — under the MCP tools that is an agent with edit
    // rights and a loop of its own.
    //
    // What still runs is polish on a bump that landed clean: tightening, then
    // the gated review. Both discover their own files from the diff now, which
    // is what the deleted repair loop was doing for them.
    let agentRecord: FixResult['agent'];
    const llm = asker({ disabled: options.useAgent !== true });
    if (!llm.ok && llm.why === 'unconfigured') progress(unconfiguredAgent(llm.reason));

    if (llm.ok && verificationPassed(verification.outcome)) {
      const dir = ws.dir;
      const extraFiles = await filesNamedInOutput(await workspaceDiff(ws), dir);
      const polishFinding: Finding = { ...finding, toVersion: worst ?? finding.toVersion };

      const tightened = await tightenAny(dir, phaseOpts, baseline, progress, (errors) =>
        repairTightening(llm.asker, dir, polishFinding, extraFiles, progress, errors),
      );
      if (tightened) verification = tightened;

      const reviewed = await reviewMigration(
        llm.asker, ws, phaseOpts, baseline, polishFinding, [],
        extraFiles, [], progress,
      );
      if (reviewed) verification = reviewed.report;
    }

    // The repo-wide review, same as the drift path. A security bump that landed
    // is still a change someone has to read, and the questions it cannot answer
    // from its own diff are identical.
    let reviewNotes: ReviewFinding[] | undefined;
    if (options.reviewHarness && verificationPassed(verification.outcome)) {
      const review = await reviewSession({
        harness: options.reviewHarness,
        dir: ws.dir,
       
          pkg: finding.pkg,
          fromVersion: finding.fromVersion,
          toVersion: worst ?? finding.toVersion,
          diff: await workspaceDiff(ws),
        progress,
      });
      if (review.findings.length > 0) reviewNotes = review.findings;
    }

    const result: VulnFixResult = {
      ...base,
      resolved,
      overrode,
      ...(reviewNotes ? { reviewNotes } : {}),
      ...(agentRecord ? { agent: agentRecord } : {}),
      installedAfter: worst,
      verification,
      diff: await workspaceDiff(ws),
      workspaceDir: ws.dir,
      workspaceMode: ws.mode,
      // Said out loud, because a green build with the vulnerable version still
      // installed is the failure most likely to be mistaken for a success.
      ...(resolved
        ? {}
        : {
            note: `the build verified, but ${finding.pkg} still resolves to ${worst ?? 'an affected version'} — this bump did not clear the advisory`,
          }),
    };
    if (!options.keepWorkspace) {
      await ws.cleanup();
      result.workspaceDir = null;
    }
    return result;
  } catch (err) {
    if (ws && !options.keepWorkspace) await ws.cleanup().catch(() => {});
    throw err;
  }
}

export interface LintFixResult {
  /** Files shellcheck rewrote. */
  repaired: string[];
  /** Edits the model made for findings no tool can fix. */
  agentEdits: number;
  /** What the verification could not actually establish. */
  caveat?: string;
  /** Findings nothing here can repair, and why. */
  unrepairable: Array<{ finding: Finding; reason: string }>;
  verification: VerificationReport | null;
  diff: string;
  workspaceDir: string | null;
  workspaceMode: string | null;
}

/**
 * Apply what the linter itself suggests, then check the repository still works.
 *
 * Only shellcheck has an autofix, so a hadolint finding comes back unrepairable
 * with the reason — reported rather than silently absent, because a repair pass
 * that quietly skips half its input reads as a repair pass that had nothing to
 * do.
 *
 * Verification is the ordinary baseline comparison. A shell script rewrite is a
 * behaviour change like any other: quoting `$f` is usually the fix and is
 * occasionally the thing that breaks a script relying on word splitting.
 */
export async function fixLint(
  repoDir: string,
  findings: Finding[],
  options: FixOptions = {},
): Promise<LintFixResult> {
  const progress = options.onProgress ?? (() => {});
  const phaseOpts = { skipTests: options.untrusted === true };

  const lintFindings: LintFinding[] = findings.map((f) => ({
    file: f.sites[0]?.file ?? '',
    line: f.sites[0]?.line ?? 1,
    column: f.sites[0]?.column ?? 1,
    code: f.change.path,
    level: f.fromVersion,
    message: f.change.guidance ?? '',
    tool: f.pkg,
  }));
  const files = repairableFiles(lintFindings);
  const unrepairable = findings
    .filter((f) => f.pkg !== 'shellcheck')
    .map((f) => ({
      finding: f,
      reason: `${f.pkg} ships no autofix, so ${f.change.path} needs a person or the agent`,
    }));

  const base: LintFixResult = {
    repaired: [],
    agentEdits: 0,
    unrepairable,
    verification: null,
    diff: '',
    workspaceDir: null,
    workspaceMode: null,
  };
  if (files.length === 0 && !options.useAgent) {
    progress(`nothing here is machine-repairable: ${unrepairable.length} finding(s) need a person`);
    return base;
  }

  let ws: Workspace | null = null;
  try {
    ws = await prepareWorkspace(repoDir);
    progress(`  workspace: ${ws.dir} (${ws.mode})`);
    progress('running baseline verification (before any change)');
    const baseline = await runPhase(ws.dir, phaseOpts);

    if (files.length > 0) {
      progress(`applying shellcheck's own suggestions to ${files.length} file(s)`);
      const patch = await applyLintPatch(ws.dir, files);
      if (!patch.applied && patch.error) progress(`  patch refused: ${patch.error}`);
    }

    // What no linter can fix on its own. hadolint ships no autofix, so these
    // are either a person's job or the model's — and the model gets a stricter
    // gate than a migration does, because the findings here are the complete
    // list of what is wrong rather than a symptom of something hidden.
    let agentEdits = 0;
    const stillUnrepairable: typeof unrepairable = [];
    const llm = asker({ disabled: options.useAgent !== true });
    if (!llm.ok && llm.why === 'unconfigured') progress(unconfiguredAgent(llm.reason));

    if (unrepairable.length > 0 && llm.ok) {
      const targets = unrepairable.map((u) => ({
        file: u.finding.sites[0]?.file ?? '',
        line: u.finding.sites[0]?.line ?? 1,
        code: u.finding.change.path,
        message: u.finding.change.guidance ?? '',
      }));
      const sources = new Map<string, string>();
      for (const file of new Set(targets.map((t) => t.file))) {
        const body = await readFile(path.join(ws.dir, file), 'utf8').catch(() => null);
        if (body !== null) sources.set(file, body);
      }

      progress(`  asking ${llm.asker.model} to repair ${targets.length} finding(s) no tool can`);
      const proposal = await runTask(llm.asker, LINT_TASK, { findings: targets, sources });
      if (!proposal.ok) {
        progress(`    provider error: ${proposal.error}`);
        stillUnrepairable.push(...unrepairable);
      } else {
        const { keep, dropped } = selectLintEdits(proposal.edits, targets, sources);
        if (dropped.length > 0) {
          progress(`    withheld ${dropped.length} edit(s) on lines no linter flagged`);
        }
        const applied = await applyTextEdits(ws.dir, keep);
        agentEdits = applied.applied.length;
        progress(`    ${agentEdits} applied, ${applied.failed.length} rejected`);
        // Only what the model actually changed leaves the unrepairable list.
        const touched = new Set(applied.applied.map((e) => e.file));
        stillUnrepairable.push(
          ...unrepairable.filter((u) => !touched.has(u.finding.sites[0]?.file ?? '')),
        );
      }
    } else {
      stillUnrepairable.push(...unrepairable);
    }

    const verification = compare(baseline, await runPhase(ws.dir, phaseOpts));
    progress(`  ${verification.outcome}`);

    // A green verification means much less for a Dockerfile than for source.
    // `npm test` does not build an image, so an edit to a `FROM` tag, a pinned
    // apt version, or a `USER` id passes untested — and the model will invent a
    // package version if a rule asks it to pin one. Saying so is the difference
    // between "verified" and "verified, in the way this repository can verify".
    const editedImages = stillUnrepairable.length < unrepairable.length;
    const dockerEdited =
      editedImages && unrepairable.some((u) => /Dockerfile|Containerfile/.test(u.finding.sites[0]?.file ?? ''));
    if (dockerEdited) {
      progress(
        '  note: the verification ran this repository’s own checks, which do not build the image — Dockerfile edits are unproven until they do',
      );
    }

    const result: LintFixResult = {
      ...base,
      unrepairable: stillUnrepairable,
      ...(dockerEdited
        ? {
            caveat:
              'Dockerfile edits were verified only against this repository’s own checks, which do not build an image. A pinned package version or a changed USER id is unproven until something builds it.',
          }
        : {}),
      agentEdits,
      repaired: files,
      verification,
      diff: await workspaceDiff(ws),
      workspaceDir: ws.dir,
      workspaceMode: ws.mode,
    };
    if (!options.keepWorkspace) {
      await ws.cleanup();
      result.workspaceDir = null;
    }
    return result;
  } catch (err) {
    if (ws && !options.keepWorkspace) await ws.cleanup().catch(() => {});
    throw err;
  }
}

/**
 * Take an upgrade the scan already proved is safe for this repository.
 *
 * A freshness finding says nothing this repository calls changed between the
 * installed version and the latest. That is a claim about the surface diff, and
 * this is where it gets tested against a build rather than left as an assertion.
 *
 * It is the same shape as any other bump, which is the point: nothing special
 * happens because the finding was cheap to produce.
 */
export async function fixFreshness(
  repoDir: string,
  finding: Finding,
  options: FixOptions = {},
): Promise<VulnFixResult> {
  const progress = options.onProgress ?? (() => {});
  const untrusted = options.untrusted === true;
  const phaseOpts = { skipTests: untrusted };

  let ws: Workspace | null = null;
  try {
    ws = await prepareWorkspace(repoDir);
    progress(`  workspace: ${ws.dir} (${ws.mode})`);
    progress('running baseline verification (before any change)');
    const baseline = await runPhase(ws.dir, phaseOpts);

    progress(`bumping ${finding.pkg} ${finding.fromVersion} -> ${finding.toVersion}`);
    await bumpDependency(ws.dir, finding.pkg, finding.toVersion, { ignoreScripts: untrusted });

    const after = await readLockfile(ws.dir);
    const installed = [...after.tree.values()].filter((e) => e.name === finding.pkg);
    const now = installed.map((e) => e.version).sort(compareVersions)[0] ?? null;
    const verification = compare(baseline, await runPhase(ws.dir, phaseOpts));
    progress(`  ${finding.pkg} now resolves to ${now ?? '(absent)'} — ${verification.outcome}`);

    const result: VulnFixResult = {
      finding,
      remediation: { kind: 'direct', pkg: finding.pkg, to: finding.toVersion },
      // The upgrade landing is the whole job here; there is no advisory to clear.
      resolved: now !== null && compareVersions(now, finding.toVersion) >= 0,
      overrode: false,
      installedAfter: now,
      verification,
      diff: await workspaceDiff(ws),
      workspaceDir: ws.dir,
      workspaceMode: ws.mode,
    };
    if (!options.keepWorkspace) {
      await ws.cleanup();
      result.workspaceDir = null;
    }
    return result;
  } catch (err) {
    if (ws && !options.keepWorkspace) await ws.cleanup().catch(() => {});
    throw err;
  }
}
