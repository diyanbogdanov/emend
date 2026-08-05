/**
 * The fix pipeline: plan -> isolated workspace -> baseline -> apply -> verify.
 *
 * Order matters. The baseline runs *before* any edit, in the same workspace, so
 * that a repository which was already red is reported as such instead of having
 * its pre-existing failures attributed to the migration.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fetchPackageDir } from './registry.ts';
import { extractSurface } from './surface.ts';
import { planFinding } from './plan.ts';
import { findWorkspaces } from './workspaces.ts';
import {
  prepareWorkspace,
  applyPlan,
  applyEdits,
  applyTextEdits,
  restoreSnapshots,
  bumpDependency,
  workspaceDiff,
  type Workspace,
} from './apply.ts';
import { runPhase, compare } from './verify.ts';
import { resolveLlmConfig } from './llm/providers.ts';
import { proposeEdits, nearbySymbols, type TextEdit } from './llm/agent.ts';
import type { ApiSymbol, CommandResult, Finding, MigrationPlan, VerificationReport } from './types.ts';

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
  onProgress?: (message: string) => void;
}

export interface AgentAttempt {
  attempt: number;
  edits: TextEdit[];
  rationale: string;
  modelConfidence: string;
  outcome: string;
  error?: string;
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
  };
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
      const agentFinding = { ...first, sites: findings.flatMap((f) => f.sites) };

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
      const ranked = findings.map((f) => nearbySymbols(f.change.path, toSymbols));
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
      let previousAttempt: { edits: TextEdit[]; errors: string } | undefined = {
        edits: [],
        errors: verificationErrors(verification),
      };

      for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
        progress(`  attempt ${attempt}/${config.maxRetries}: requesting edits`);
        const proposal = await proposeEdits(config, {
          // Present the whole upgrade, not one finding — a version bump is
          // atomic and the model must see every break to produce a coherent set
          // of edits.
          finding: first,
          changes: findings.map((f) => ({ change: f.change, sites: f.sites })),
          sources,
          candidateSymbols: candidates,
          ...(previousAttempt ? { previousAttempt } : {}),
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
        const editResult = await applyTextEdits(ws.dir, proposal.edits);
        progress(`    ${editResult.applied.length} applied, ${editResult.failed.length} rejected`);

        if (editResult.applied.length === 0) {
          const why = editResult.failed.map((f) => f.reason).join('; ');
          attempts.push({ attempt, edits: proposal.edits, rationale: proposal.rationale, modelConfidence: proposal.modelConfidence, outcome: 'all-edits-rejected', error: why });
          previousAttempt = { edits: proposal.edits, errors: `Your edits were rejected: ${why}` };
          await restoreSnapshots(ws.dir, editResult.snapshots);
          continue;
        }

        post = await runPhase(ws.dir, phaseOpts);
        const report = compare(baseline, post);
        progress(`    verification: ${report.outcome}`);
        attempts.push({ attempt, edits: proposal.edits, rationale: proposal.rationale, modelConfidence: proposal.modelConfidence, outcome: report.outcome });

        appliedCount += editResult.applied.length;
        verification = report;
        if (report.outcome === 'verified' || report.outcome === 'typecheck-only') break;

        if (attempt < config.maxRetries) {
          await restoreSnapshots(ws.dir, editResult.snapshots);
          appliedCount -= editResult.applied.length;
          previousAttempt = { edits: proposal.edits, errors: verificationErrors(report) };
        }
      }

      agentRecord = { model: config.model, provider: config.providerLabel, attempts, rationale };
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
  };
}

function describe(r: CommandResult): string {
  if (r.skipped) return `skipped(${r.skipReason})`;
  return r.ok ? 'pass' : `FAIL(exit ${r.exitCode})`;
}
