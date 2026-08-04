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
  ].slice(0, 12);
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
 * Repository files named by compiler or test output.
 *
 * An upgrade can break a file that contains no call site at all. a scanned repository
 * asserts its Dockerfile's Playwright image tag matches package.json, so bumping
 * the dependency fails a test in a file the call-site walk never visits — and
 * the agent, shown only call-site files, correctly declined because it could not
 * see what was wrong. Feeding it the files the failure actually names closes
 * that gap without guessing at what else might be relevant.
 */
function filesNamedInOutput(output: string, repoDir: string): string[] {
  const found = new Set<string>();
  // Paths with a source extension, plus extensionless files a build commonly
  // pins versions in. `Dockerfile` has no extension and would otherwise be
  // invisible to a path regex.
  const pattern =
    /(?:^|[\s('"[])((?:[\w.@-]+\/)*(?:[\w.@-]+\.(?:[cm]?tsx?|[cm]?jsx?|json|ya?ml)|Dockerfile[\w.-]*|Makefile))(?=[\s:(),'"\]]|$)/gm;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(output)) !== null) {
    const rel = m[1];
    if (!rel) continue;
    if (rel.startsWith('node_modules/') || rel.includes('/node_modules/')) continue;
    if (!existsSync(path.join(repoDir, rel))) continue;
    found.add(rel);
    if (found.size >= 6) break;
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
    if (r.stdout.trim()) parts.push(r.stdout.trim().slice(-3000));
    if (r.stderr.trim()) parts.push(r.stderr.trim().slice(-3000));
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

  let ws: Workspace | null = null;
  try {
    ws = await prepareWorkspace(repoDir);
    progress(`  workspace: ${ws.dir} (${ws.mode})`);

    progress('running baseline verification (before any change)');
    const baseline = await runPhase(ws.dir);
    progress(
      `  baseline: typecheck=${describe(baseline.typecheck)} test=${describe(baseline.test)}`,
    );

    progress(`bumping ${pkg} ${fromVersion} -> ${toVersion}`);
    const bump = await bumpDependency(ws.dir, pkg, toVersion);

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
    let post = await runPhase(ws.dir);
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
      const collateral = filesNamedInOutput(failureOutput, ws.dir);
      let sources = await loadSources(ws.dir, agentFinding, collateral);
      const referenced = filesNamedInOutput(
        [...sources.values()].join('\n'),
        ws.dir,
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

        post = await runPhase(ws.dir);
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

export async function fixFinding(
  repoDir: string,
  finding: Finding,
  options: FixOptions = {},
): Promise<FixResult> {
  const progress = options.onProgress ?? (() => {});

  progress(`planning ${finding.change.path}`);
  const toSymbols = await targetSymbols(finding);
  const plan = planFinding(finding, toSymbols);

  const deterministicReason =
    finding.change.kind === 'deprecated'
      ? 'symbol is deprecated but still present; no mechanical replacement is derivable from the type surface alone'
      : 'no unambiguous replacement symbol with a matching signature was found — Emend will not guess';

  // Resolve the agent up front so we can decline cheaply, before paying for a
  // workspace, when there is nothing that could possibly produce a fix.
  const llm = options.useAgent ? resolveLlmConfig() : null;
  if (!plan && (!llm || !llm.ok)) {
    return {
      finding,
      plan: null,
      unplannableReason:
        llm && !llm.ok
          ? `${deterministicReason}. Agent unavailable: ${llm.reason}`
          : `${deterministicReason}. Re-run with --agent to let a model attempt it.`,
      verification: null,
      diff: '',
      appliedEdits: 0,
      failedEdits: [],
      bump: null,
      workspaceDir: null,
      workspaceMode: null,
    };
  }

  progress(`preparing isolated workspace`);
  let ws: Workspace | null = null;
  try {
    ws = await prepareWorkspace(repoDir);
    progress(`  workspace: ${ws.dir} (${ws.mode})`);

    progress('running baseline verification (before any change)');
    const baseline = await runPhase(ws.dir);
    progress(
      `  baseline: typecheck=${describe(baseline.typecheck)} test=${describe(baseline.test)}`,
    );

    let verification: VerificationReport;
    let appliedCount = 0;
    let failedEdits: Array<{ file: string; line: number; reason: string }> = [];
    let bump: CommandResult | null = null;
    let agentRecord: FixResult['agent'];

    if (plan) {
      progress(`applying ${plan.edits.length} deterministic edit(s), bumping to ${plan.toVersion}`);
      const applied = await applyPlan(ws, plan);
      bump = applied.bump;
      appliedCount = applied.edits.applied.length;
      failedEdits = applied.edits.failed.map((f) => ({
        file: f.edit.file,
        line: f.edit.line,
        reason: f.reason,
      }));

      progress('running post-change verification');
      const post = await runPhase(ws.dir);
      progress(`  post: typecheck=${describe(post.typecheck)} test=${describe(post.test)}`);
      verification = compare(baseline, post);
    } else {
      // Agent path. The model proposes; deterministic code applies and judges.
      const config = llm && llm.ok ? llm.config : null;
      if (!config) throw new Error('agent requested but no configuration resolved');

      progress(`agent: ${config.model} via ${config.providerLabel}`);
      const sources = await loadSources(ws.dir, finding);
      const candidates = nearbySymbols(finding.change.path, toSymbols);
      const attempts: AgentAttempt[] = [];

      // The dependency bump happens once, before any attempt: the model needs to
      // be verified against the NEW version, which is the whole point.
      progress(`  bumping ${finding.pkg} to ${finding.toVersion}`);
      bump = await bumpDependency(ws.dir, finding.pkg, finding.toVersion);

      let best: VerificationReport | null = null;
      let previousAttempt: { edits: TextEdit[]; errors: string } | undefined;
      let rationale = '';

      for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
        progress(`  attempt ${attempt}/${config.maxRetries}: requesting edits`);
        const proposal = await proposeEdits(config, {
          finding,
          changes: [{ change: finding.change, sites: finding.sites }],
          sources,
          candidateSymbols: candidates,
          ...(previousAttempt ? { previousAttempt } : {}),
        });

        if (!proposal.ok) {
          attempts.push({
            attempt,
            edits: [],
            rationale: '',
            modelConfidence: 'low',
            outcome: 'provider-error',
            error: proposal.error ?? 'unknown',
          });
          progress(`    provider error: ${proposal.error}`);
          break;
        }
        if (proposal.edits.length === 0) {
          attempts.push({
            attempt,
            edits: [],
            rationale: proposal.rationale,
            modelConfidence: proposal.modelConfidence,
            outcome: 'declined',
          });
          progress(`    model declined: ${proposal.rationale.slice(0, 160)}`);
          break;
        }

        rationale = proposal.rationale;
        const editResult = await applyTextEdits(ws.dir, proposal.edits);
        progress(
          `    ${editResult.applied.length} edit(s) applied, ${editResult.failed.length} rejected`,
        );

        if (editResult.applied.length === 0) {
          const why = editResult.failed.map((f) => f.reason).join('; ');
          attempts.push({
            attempt,
            edits: proposal.edits,
            rationale: proposal.rationale,
            modelConfidence: proposal.modelConfidence,
            outcome: 'all-edits-rejected',
            error: why,
          });
          previousAttempt = { edits: proposal.edits, errors: `Your edits were rejected: ${why}` };
          await restoreSnapshots(ws.dir, editResult.snapshots);
          continue;
        }

        const post = await runPhase(ws.dir);
        const report = compare(baseline, post);
        progress(`    verification: ${report.outcome}`);

        attempts.push({
          attempt,
          edits: proposal.edits,
          rationale: proposal.rationale,
          modelConfidence: proposal.modelConfidence,
          outcome: report.outcome,
        });

        best = report;
        appliedCount = editResult.applied.length;
        failedEdits = editResult.failed.map((f) => ({
          file: f.edit.file,
          line: 0,
          reason: f.reason,
        }));

        if (report.outcome === 'verified' || report.outcome === 'typecheck-only') break;

        // Failed: roll back and feed the compiler its own complaint.
        if (attempt < config.maxRetries) {
          await restoreSnapshots(ws.dir, editResult.snapshots);
          previousAttempt = { edits: proposal.edits, errors: verificationErrors(report) };
        }
      }

      verification =
        best ??
        compare(baseline, {
          typecheck: {
            command: 'agent',
            ok: false,
            exitCode: null,
            stdout: '',
            stderr: '',
            skipped: true,
            skipReason: 'agent produced no applicable edits',
          },
          test: {
            command: 'agent',
            ok: false,
            exitCode: null,
            stdout: '',
            stderr: '',
            skipped: true,
            skipReason: 'agent produced no applicable edits',
          },
        });

      agentRecord = {
        model: config.model,
        provider: config.providerLabel,
        attempts,
        rationale,
      };
    }

    const diff = await workspaceDiff(ws);

    const result: FixResult = {
      finding,
      plan,
      ...(plan ? {} : { unplannableReason: deterministicReason }),
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
    if (ws && !options.keepWorkspace) {
      await ws.cleanup().catch(() => {});
    }
    throw err;
  }
}

function describe(r: CommandResult): string {
  if (r.skipped) return `skipped(${r.skipReason})`;
  return r.ok ? 'pass' : `FAIL(exit ${r.exitCode})`;
}
