/**
 * The repo-wide review: what a structured-edit pass structurally cannot see.
 *
 * There are now two reviews, and the split is not arbitrary — it follows from
 * what each one is able to say.
 *
 * `reviewMigration` proposes *edits*, and `selectReviewEdits` confines them to
 * lines the migration changed. That gate exists because an unanchored review
 * wanders: measured live, it rewrote a working `cancelToken` into an
 * `AbortSignal`, changing an exported signature to modernise an API carrying no
 * deprecation marker. So the structured review handles what is visible in the
 * diff and can be fixed inside it.
 *
 * Everything else in the thermo-nuclear criteria needs the repository, not the
 * diff: whether this change pushed a file past the point of being readable,
 * whether a helper it added duplicates one that already exists three directories
 * away, whether feature logic has leaked into a module that is supposed to be
 * general. None of those can be answered from the changed lines, and none of
 * them can be *fixed* by an edit confined to the changed lines — so asking the
 * structured pass for them spends its single attempt on edits the gate will
 * discard.
 *
 * **Read-only, and that is the whole safety argument.** This harness produces
 * findings for a human, never edits. `classifyHunks` gates the repair harness by
 * reading what it changed; a run that changes nothing needs no such gate, and
 * cannot introduce the regression an ungated writer could. The permission is
 * denied at the harness *and* the workspace is checked afterwards — a run that
 * modified anything is refused rather than reported, because a read-only tool
 * that wrote is a tool behaving differently from its contract, and the findings
 * of a process that ignored one instruction are not evidence.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Harness } from './harness.ts';

const execFileAsync = promisify(execFile);

/**
 * Ordered by the priority the criteria themselves set: a structural regression
 * outranks every simplification below it, and naming a nit while one stands is a
 * wasted review.
 */
export type ReviewSeverity = 'structural' | 'duplication' | 'boundary' | 'size';

export interface ReviewFinding {
  severity: ReviewSeverity;
  /** Repo-relative, so a reader can open it. */
  file: string;
  /** What is wrong, stated as a claim rather than a suggestion. */
  what: string;
  /** Why it matters here, which is what makes it actionable rather than a nit. */
  why: string;
}

const SEVERITIES: ReadonlySet<string> = new Set([
  'structural',
  'duplication',
  'boundary',
  'size',
]);

/**
 * What to ask, given that the answer can only be words.
 *
 * Deliberately excludes everything `reviewMigration` already covers. Two passes
 * reporting the same casts and the same missing helper is not redundancy that
 * makes the result safer — it is one finding arriving twice, in a PR body where
 * a reader's attention is the scarce thing.
 */
export function reviewPrompt(input: {
  pkg: string;
  fromVersion: string;
  toVersion: string;
  diff: string;
}): string {
  return [
    `A dependency upgrade has been applied to this repository and it verifies: ${input.pkg} ${input.fromVersion} -> ${input.toVersion}.`,
    'Your job is to judge whether it is worth merging. Read the repository — you have read-only access and cannot change anything.',
    '',
    'Here is the whole change:',
    '```diff',
    input.diff.slice(0, 60_000),
    '```',
    '',
    'A separate pass already reviews the diff in isolation for casts, `any`, unnecessary optionality, added branching, duplicated edits, and wrapper indirection. Do NOT report those; they are covered.',
    '',
    'Report only what requires reading the repository rather than the diff:',
    '1. `structural` — feature-specific logic added to a module that is supposed to be general-purpose, or a change to a shared module that only one caller wanted. Name the caller and the module.',
    '2. `duplication` — a helper or constant this change introduced that already exists elsewhere under another name. Name both paths. This is the finding a diff-only reviewer can never make, so it is the most valuable thing you can return.',
    '3. `boundary` — an invariant this change now relies on that is enforced nowhere, or one enforced in a layer that does not own it.',
    '4. `size` — a file this change pushed past the point where a reader can hold it, with no structural reason. Say the line count. Do not report a file that was already long and that this change barely touched.',
    '',
    'Rules:',
    '- Report nothing you have not opened the relevant files to confirm. A plausible guess costs a reader more than silence.',
    '- No cosmetic or naming notes. If you have no structural finding, say so — an empty list is a real and useful answer.',
    '- Prefer a small number of high-conviction findings over an exhaustive list.',
    '',
    'Output ONLY a JSON object, no prose and no markdown fences:',
    '{"findings": [{"severity": "structural" | "duplication" | "boundary" | "size", "file": "<repo-relative path>", "what": "<the claim>", "why": "<why it matters here>"}]}',
  ].join('\n');
}

/**
 * Read findings out of whatever the harness printed.
 *
 * Tolerant on the way in and strict on the way out. A harness log is a
 * transcript, not a response — the JSON arrives surrounded by tool calls and
 * commentary, and the last object is the one that concluded. Anything that does
 * not carry all four fields with a known severity is dropped, because a partial
 * finding rendered into a PR body reads as authoritative regardless.
 */
export function parseReviewFindings(log: string): ReviewFinding[] {
  const candidates = [...log.matchAll(/\{[\s\S]*?"findings"[\s\S]*?\]\s*\}/g)].map((m) => m[0]);
  for (const raw of candidates.reverse()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const list = (parsed as { findings?: unknown }).findings;
    if (!Array.isArray(list)) continue;
    return list.filter((f): f is ReviewFinding => {
      const r = f as Record<string, unknown>;
      return (
        typeof r['severity'] === 'string' &&
        SEVERITIES.has(r['severity']) &&
        typeof r['file'] === 'string' &&
        r['file'] !== '' &&
        typeof r['what'] === 'string' &&
        r['what'] !== '' &&
        typeof r['why'] === 'string'
      );
    });
  }
  return [];
}

export interface HarnessReview {
  ok: boolean;
  findings: ReviewFinding[];
  log: string;
  /** Why there are no findings, when that is not the same as "found nothing". */
  reason?: string;
}

/** Files the workspace reports as changed, so "it edited nothing" can be checked. */
async function changedFiles(dir: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', [
    '-C', dir, 'status', '--porcelain', '--', '.', ':(exclude)**/node_modules/**',
  ]).catch(() => ({ stdout: '' }));
  return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

/**
 * Run the review harness and return only what it is entitled to claim.
 *
 * The workspace is compared before and after. A read-only run that wrote is a
 * tool that ignored its own configuration, and nothing it says afterwards is
 * evidence — so the findings are discarded and the reason is reported, rather
 * than quietly trusting a process that already disregarded one instruction.
 */
export async function harnessReview(input: {
  harness: Harness;
  dir: string;
  pkg: string;
  fromVersion: string;
  toVersion: string;
  diff: string;
  progress?: (message: string) => void;
}): Promise<HarnessReview> {
  const progress = input.progress ?? (() => {});
  const before = await changedFiles(input.dir);

  const run = await input.harness.run(input.dir, {
    instruction: reviewPrompt(input),
    failureOutput: '',
  });

  const after = await changedFiles(input.dir);
  if (after.join('\n') !== before.join('\n')) {
    const reason =
      'the review harness modified the workspace despite running read-only; its findings are discarded';
    progress(`  ${reason}`);
    return { ok: false, findings: [], log: run.log, reason };
  }

  if (!run.ok) {
    return { ok: false, findings: [], log: run.log, reason: run.error ?? 'the review harness failed' };
  }

  const findings = parseReviewFindings(run.log);
  progress(
    findings.length === 0
      ? '  repo-wide review: no structural findings'
      : `  repo-wide review: ${findings.length} finding(s)`,
  );
  return { ok: true, findings, log: run.log };
}

/**
 * Render findings for the pull request body.
 *
 * Nothing is rendered when nothing was found — an empty heading reads as a
 * verdict, and this pass is advisory. Silence has to stay silence.
 */
export function renderReviewFindings(findings: ReviewFinding[]): string {
  if (findings.length === 0) return '';
  const order: ReviewSeverity[] = ['structural', 'duplication', 'boundary', 'size'];
  const sorted = [...findings].sort(
    (a, b) => order.indexOf(a.severity) - order.indexOf(b.severity),
  );
  const lines = [
    '### Review notes',
    '',
    'A read-only pass over the repository, not the diff. These are observations for a human — nothing here was changed automatically.',
    '',
  ];
  for (const f of sorted) {
    lines.push(`- **${f.severity}** · \`${f.file}\` — ${f.what}`);
    if (f.why) lines.push(`  ${f.why}`);
  }
  return lines.join('\n');
}
