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
import { diffSurfaces } from './diff.ts';
import { planFinding } from './plan.ts';
import { findWorkspaces } from './workspaces.ts';
import { readRepo } from './inventory.ts';
import { scanPins, resolvedVersions, planPinRepair } from './pins.ts';
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
import { resolveLlmConfig, type LlmConfig } from './llm/providers.ts';
import {
  proposeEdits,
  proposeTightening,
  proposeReview,
  nearbySymbols,
  classifyEdits,
  selectEvidencedEdits,
  NARROWING_RULE,
  type TextEdit,
  type EditClassification,
  type HunkClassification,
} from './llm/agent.ts';
import { escalate, harnessPermitted, type Harness } from './harness.ts';
import {
  remainingDeprecations,
  describeDeprecationGaps,
  deprecationStillPresent,
} from './quality.ts';
import type {
  ApiSymbol,
  CallSite,
  CommandResult,
  Finding,
  MigrationPlan,
  PinConflict,
  SurfaceChange,
  VerificationReport,
} from './types.ts';

const execFileAsync = promisify(execFile);

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
}

/**
 * Recompute the target version's symbol table.
 *
 * The scan stores only consumer-impacting changes, but the planner needs the full
 * set of symbols in the new version to find a replacement. Tarballs are cached,
 * so recomputing is cheaper and less error-prone than persisting a large
 * denormalised blob alongside every finding.
 */
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
  config: LlmConfig,
  dir: string,
  finding: Finding,
  extraFiles: string[],
  progress: (message: string) => void,
  errors: string,
): Promise<number | null> {
  const proposal = await proposeTightening(config, {
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
  config: LlmConfig,
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

  const proposal = await proposeReview(config, {
    finding,
    sources: await loadSources(ws.dir, finding, extraFiles),
    diff: await workspaceDiff(ws),
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
  const applied = await applyTextEdits(ws.dir, proposal.edits);
  if (applied.applied.length === 0) {
    progress(`    review: none of ${proposal.edits.length} edit(s) matched the source`);
    return null;
  }
  progress(`    review: applied ${applied.applied.length} of ${proposal.edits.length} edit(s)`);

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

async function targetSymbols(finding: Finding): Promise<Record<string, ApiSymbol>> {
  const toDir = await fetchPackageDir(finding.pkg, finding.toVersion);
  const toSurface = await extractSurface(toDir, finding.pkg, finding.toVersion);
  return toSurface.symbols;
}

/**
 * API changes the compiler is complaining about, whether or not they became
 * findings.
 *
 * Reporting is deliberately conservative: on a major upgrade, a signature change
 * is only surfaced when a required parameter appeared, because anything looser
 * buried real findings under an internal rewrite — removing that gate turned one
 * repository's 153 call sites into 4,052.
 *
 * But a filter that is right for a dashboard is wrong for the model. recharts 2
 * to 3 changed `Tooltip` from `typeof Tooltip` to
 * `(outsideProps: TooltipProps<ValueType, NameType>) => any`; that was in the
 * diff, filtered from findings, and every compiler error was about it. The model
 * was handed "Cell is deprecated", saw fourteen errors about Tooltip, and
 * declined — correctly, because it had been given the wrong contract.
 *
 * Selecting by what the compiler actually named keeps the reporting filter
 * intact while giving the model the part of the diff that explains its errors.
 */
async function changesNamedInErrors(
  finding: Finding,
  errors: string,
): Promise<Array<{ change: SurfaceChange; sites: CallSite[] }>> {
  if (!errors.trim()) return [];
  try {
    const [fromDir, toDir] = await Promise.all([
      fetchPackageDir(finding.pkg, finding.fromVersion),
      fetchPackageDir(finding.pkg, finding.toVersion),
    ]);
    const [fromSurface, toSurface] = await Promise.all([
      extractSurface(fromDir, finding.pkg, finding.fromVersion),
      extractSurface(toDir, finding.pkg, finding.toVersion),
    ]);

    const out: Array<{ change: SurfaceChange; sites: CallSite[] }> = [];
    for (const change of diffSurfaces(fromSurface, toSurface).changes) {
      if (change.kind === 'added') continue;
      const leaf = change.path.split('.').at(-1) ?? '';
      // Word-boundary match: `Cell` must not be found inside `CellProps`.
      if (leaf.length < 3) continue;
      if (!new RegExp(`\\b${leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(errors)) continue;
      out.push({ change, sites: [] });
      if (out.length >= 25) break;
    }
    return out;
  } catch {
    return [];
  }
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
function symbolsNamedInErrors(
  errors: string,
  toSymbols: Record<string, ApiSymbol>,
): string[] {
  if (!errors.trim()) return [];
  const mentioned = new Set(errors.match(/\b[A-Z][A-Za-z0-9_]{3,}\b/g) ?? []);
  if (mentioned.size === 0) return [];

  const hits: string[] = [];
  for (const symbol of Object.values(toSymbols)) {
    if (symbol.deprecated) continue;
    const leaf = symbol.path.split('.').at(-1) ?? '';
    if (leaf.length < 4) continue;
    for (const token of mentioned) {
      if (leaf === token || leaf.includes(token)) {
        hits.push(symbol.path);
        break;
      }
    }
    if (hits.length >= 40) break;
  }
  return hits;
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


/**
 * How badly the post-change run failed, as a count of reported errors.
 *
 * Crude on purpose: it only has to order two attempts, not describe them.
 */
function failureSize(report: VerificationReport): number {
  const text = verificationErrors(report);
  const compiler = text.match(/error TS\d+/g)?.length ?? 0;
  if (compiler > 0) return compiler;
  const failing = text.match(/^\s*(FAIL|✕|✗|×)/gm)?.length ?? 0;
  return failing > 0 ? failing : 1;
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

  const llm = options.useAgent ? resolveLlmConfig() : null;
  // Asking for the agent and silently not getting one is the worst of both:
  // the run looks like the model tried and failed, when it never ran at all.
  if (llm && !llm.ok) {
    progress(`agent requested but unavailable: ${llm.reason}`);
  }

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
    let agentRecord: FixResult['agent'];
    if (
      verification.outcome !== 'verified' &&
      verification.outcome !== 'typecheck-only' &&
      llm?.ok
    ) {
      const config = llm.config;
      progress(`agent: ${config.model} via ${config.providerLabel}`);
      const failureOutput = verificationErrors(verification);

      // Two hops, which is what this class of failure needs. The output names a
      // failing test; that test names the file it asserts against. a scanned repository's
      // Docker contract test is exactly this shape — the output never mentions
      // the Dockerfile, only the test that reads it.
      const collateral = await filesNamedInOutput(failureOutput, ws.dir);
      let sources = await loadSources(ws.dir, agentFinding, collateral);
      const referenced = (
        await filesNamedInOutput([...sources.values()].join('\n'), ws.dir)
      ).filter((f) => !sources.has(f));
      if (referenced.length > 0) {
        sources = await loadSources(ws.dir, agentFinding, [...collateral, ...referenced]);
      }
      const added = [...sources.keys()].filter(
        (f) => !agentFinding.sites.some((s) => s.file === f),
      );
      if (added.length > 0) progress(`  including ${added.join(', ')}`);
      // Interleave each finding's relevance-ranked candidates rather than
      // concatenating them. Concatenation means the prompt's cutoff falls inside
      // the first finding's list, so with nine broken symbols the model never
      // sees a replacement for eight of them.
      // Symbols the compiler itself named come first. The candidate list is
      // ranked by name similarity to the *findings*, so migrating `Cell` ranked
      // `TooltipValueType` near the bottom and the cutoff removed it — even
      // though recharts exports it publicly and it is exactly the type the
      // errors are about. The model, told to use only listed symbols, then had
      // no way to name the constraint and widened to `any` instead.
      const namedByCompiler = symbolsNamedInErrors(failureOutput, toSymbols);
      const ranked = [
        namedByCompiler,
        ...findings.map((f) => nearbySymbols(f.change.path, toSymbols)),
      ];
      const candidates: string[] = [];
      const seen = new Set<string>();
      for (let i = 0; i < Math.max(0, ...ranked.map((r) => r.length)); i++) {
        for (const list of ranked) {
          const symbol = list[i];
          if (symbol !== undefined && !seen.has(symbol)) {
            seen.add(symbol);
            candidates.push(symbol);
          }
        }
      }
      const attempts: AgentAttempt[] = [];
      let rationale = '';
      // What the agent was handed, before it changed anything. Kept so a run
      // that took fourteen errors to two is distinguishable from one that took
      // fourteen to fourteen — both fail, and they are not the same result.
      const initialErrors = failureSize(verification);
      let bestFailureSize = initialErrors;
      let previousSize = bestFailureSize;
      // The errors belonging to whatever is currently on disk. After a rollback
      // the failed attempt's errors describe a state that no longer exists, and
      // showing those alongside the restored sources asks the model to fix
      // problems that are not there while hiding the one that is.
      let bestErrors = verificationErrors(verification);
      // The edit sets already tried, so attempt 3 cannot re-propose what attempt
      // 1 already burned. Deliberately separate from `bestErrors`, which is what
      // is broken *now*: one slot could not hold both, which is why it had to be
      // handed the current failure under a heading claiming those edits had been
      // applied.
      const previousAttempts: Array<{ edits: TextEdit[]; errors: string }> = [];

      for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
        progress(`  attempt ${attempt}/${config.maxRetries}: requesting edits`);
        // Recomputed each attempt: the compiler names different symbols as
        // earlier errors are fixed, so the contract shown should follow it.
        const explaining = await changesNamedInErrors(first, bestErrors);
        const detected = findings.map((f) => ({ change: f.change, sites: f.sites }));
        const known = new Set(detected.map((c) => c.change.path));
        // Also the basis the evidence gate judges against, so a call site that
        // only the compiler named counts the same as one the diff found.
        const agentChanges = [
          ...detected,
          ...explaining.filter((c) => !known.has(c.change.path)),
        ];

        const proposal = await proposeEdits(config, {
          // Present the whole upgrade, not one finding — a version bump is
          // atomic and the model must see every break to produce a coherent set
          // of edits.
          finding: first,
          changes: agentChanges,
          sources,
          candidateSymbols: candidates,
          failureOutput: bestErrors,
          ...(previousAttempts.length > 0 ? { previousAttempts: [...previousAttempts] } : {}),
        });

        if (!proposal.ok) {
          attempts.push({ attempt, edits: [], rationale: '', modelConfidence: 'low', outcome: 'provider-error', error: proposal.error ?? 'unknown' });
          progress(`    provider error: ${proposal.error}`);
          break;
        }
        if (proposal.edits.length === 0) {
          attempts.push({ attempt, edits: [], rationale: proposal.rationale, modelConfidence: proposal.modelConfidence, outcome: 'declined' });
          progress(`    model declined: ${proposal.rationale.slice(0, 160)}`);
          break;
        }

        rationale = proposal.rationale;

        // Deprecations that are still present, so the gate below does not
        // withhold the edits that would resolve them. Recomputed each attempt
        // against the sources as they stand: once the symbol is gone the finding
        // is settled and further edits to that line are churn again.
        const stillDeprecated = new Set(
          agentChanges
            .filter(({ change }) => change.kind === 'deprecated')
            .filter(({ change, sites }) =>
              sites.some((s) => {
                const source = sources.get(s.file);
                return source ? deprecationStillPresent(change.path, first.pkg, source) : false;
              }),
            )
            .map(({ change }) => change.path),
        );

        // Withhold edits the current failure does not ask for. Nothing later can
        // do this: an unnecessary edit that compiles and passes the tests is
        // invisible to verification precisely because it is not wrong.
        const classified = classifyEdits(
          proposal.edits,
          agentChanges,
          bestErrors,
          sources,
          stillDeprecated,
        );
        const { keep, dropped } = selectEvidencedEdits(classified);
        if (dropped.length > 0) {
          progress(`    withheld ${dropped.length} edit(s) no diagnostic asked for`);
        }

        const editResult = await applyTextEdits(ws.dir, keep);
        progress(`    ${editResult.applied.length} applied, ${editResult.failed.length} rejected`);

        const record: Omit<AgentAttempt, 'outcome'> = {
          attempt,
          edits: keep,
          rationale: proposal.rationale,
          modelConfidence: proposal.modelConfidence,
          ...(dropped.length > 0 ? { droppedEdits: dropped } : {}),
        };

        if (editResult.applied.length === 0) {
          const why = editResult.failed.map((f) => f.reason).join('; ');
          attempts.push({ ...record, outcome: 'all-edits-rejected', error: why });
          previousAttempts.push({
            edits: proposal.edits,
            errors: `every edit was rejected — ${why}`,
          });
          await restoreSnapshots(ws.dir, editResult.snapshots);
          continue;
        }

        post = await runPhase(ws.dir, phaseOpts);
        const report = compare(baseline, post);
        progress(`    verification: ${report.outcome}`);
        attempts.push({ ...record, outcome: report.outcome });

        appliedCount += editResult.applied.length;
        verification = report;
        if (verificationPassed(report.outcome)) break;

        if (attempt < config.maxRetries) {
          // Keep progress. Reverting every failed attempt made the retries three
          // independent one-shots: an attempt that fixed ten of fourteen errors
          // was discarded, and the next one started from fourteen again. A wide
          // migration cannot converge that way. Edits are kept when they reduce
          // the failure and rolled back when they do not, so the loop climbs
          // instead of restarting.
          const size = failureSize(report);
          const kept = size < bestFailureSize;
          if (kept) {
            bestFailureSize = size;
            bestErrors = verificationErrors(report);
            progress(`    kept (${size} error(s) remain, was ${previousSize})`);
            // The files on disk are no longer the ones the model was shown.
            sources = await loadSources(ws.dir, agentFinding, [...collateral, ...referenced]);
          } else {
            progress(`    rolled back (${size} error(s), no improvement on ${bestFailureSize})`);
            await restoreSnapshots(ws.dir, editResult.snapshots);
            appliedCount -= editResult.applied.length;
          }
          previousSize = size;
          // The whole proposal is recorded, including edits the gate withheld,
          // so none of them come back. `bestErrors` already carries what is
          // broken now; this only needs to say how the attempt ended.
          previousAttempts.push({
            edits: proposal.edits,
            errors: kept
              ? `kept — ${size} error(s) still remained`
              : `rolled back — ${size} error(s), no improvement`,
          });
        }
      }

      agentRecord = {
        model: config.model,
        provider: config.providerLabel,
        attempts,
        rationale,
        initialErrors,
        finalErrors: verificationPassed(verification.outcome) ? 0 : failureSize(verification),
      };

      // The migration is green. Now find out how much of its `any` was real.
      if (verificationPassed(verification.outcome)) {
        const dir = ws.dir;
        const extraFiles = [...collateral, ...referenced];
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
              `no refactoring of code that already works.\n\n${NARROWING_RULE}`,
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
