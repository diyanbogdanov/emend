import type { Harness } from './harness.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
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
  // Shaped by what actually worked. A direct `opencode run` with a short,
  // exploration-first prompt found four real problems on a repository where this
  // prompt found none — and the difference was not the criteria, which were
  // nearly identical. It was the order and the weight: this led with sixty
  // thousand characters of diff, which anchors the model on judging the diff.
  // The diff is context here. The repository is the subject.
  return [
    'Review this repository for STRUCTURAL code quality. Report only — change nothing.',
    '',
    'Read the files under the source directory before answering. Start with the files the change below touches, then their neighbours in the tree. A conclusion drawn from paths alone is worthless: duplication and misplaced logic are only visible in the contents.',
    '',
    'Priorities, in order — a structural regression outranks everything below it, and naming a lesser problem while one stands is a wasted review:',
    '- `duplication` — a helper or constant that already exists elsewhere under another name. Name both paths. This is the finding a diff-only reviewer can never make, so it is the most valuable thing you can return.',
    '- `structural` — feature-specific logic living in a module meant to be general-purpose. Name the module and the caller it was added for.',
    '- `complexity` — ad-hoc branching or a special case bolted onto an existing flow, especially a "temporary" one.',
    '- `boundary` — an invariant relied on but enforced nowhere, or enforced in a layer that does not own it.',
    '- `atomicity` — independent work made sequential, or steps that leave state half-applied if one throws.',
    '- `size` — a file pushed past what a reader can hold, with no structural reason. Give the line count.',
    '',
    'Do NOT report cosmetic or naming nits. Do NOT report casts, `any`, unnecessary optionality or wrapper indirection inside the change itself — a separate pass already covers those, and repeating them spends this one for nothing.',
    '',
    `For context, a dependency upgrade was just applied and it verifies: ${input.pkg} ${input.fromVersion} -> ${input.toVersion}. Verifying is not the bar — that is why you are being asked. Prefer the move that DELETES complexity over one that rearranges it.`,
    '',
    '```diff',
    // Deliberately a fraction of what it was. The diff says where to start
    // looking; it is not the thing being judged, and at full length it crowds
    // out the instruction to go and read.
    input.diff.slice(0, 12_000),
    '```',
    '',
    'Output ONLY a JSON object, no prose and no markdown fences. An empty list is a real and useful answer:',
    '{"findings": [{"severity": "duplication" | "structural" | "complexity" | "boundary" | "atomicity" | "size", "file": "<repo-relative path>", "what": "<the claim>", "why": "<why it costs a reader here>"}]}',
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
export function parseReviewFindings(log: string): ReviewFinding[] | null {
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
  // No findings object at all — the harness did not answer the question. That is
  // NOT an empty result. Measured live: opencode failed to resolve a model,
  // printed an APIError, exited zero, and this reported "no structural findings"
  // — a clean bill of health from a review that never ran.
  return null;
}

export interface HarnessReview {
  ok: boolean;
  findings: ReviewFinding[];
  log: string;
  /** Why there are no findings, when that is not the same as "found nothing". */
  reason?: string;
}

/**
 * Review the diff in a fresh agent session, separate from the one that made it.
 *
 * Fresh is the point. A model reviewing its own work argues for it; a session
 * that never saw the reasoning only has the code. The repair session and this
 * one share nothing but the checkout.
 *
 * Read-only by instruction and by evidence, not by permission. The harness is
 * told to change nothing, and `changedFiles` is compared before and after — a
 * review that edited the workspace has its findings discarded, because a
 * reviewer that rewrites the thing it is judging has stopped being one.
 *
 * The earlier version of this asked the model to simulate tool use in prose,
 * and it answered without opening a file — twice, including after being told to
 * read. That was the mechanism, not the model: given real tools through
 * opencode, the same GLM 5.2 ran `ls`, read every source file, found both
 * planted problems and two nobody planted, including a latent correctness bug.
 */
export async function reviewSession(input: {
  harness: Harness;
  dir: string;
  pkg: string;
  fromVersion: string;
  toVersion: string;
  diff: string;
  progress?: (message: string) => void;
}): Promise<HarnessReview> {
  const progress = input.progress ?? (() => {});
  const available = await input.harness.available();
  if (!available.ok) {
    const reason = `review harness unavailable: ${available.reason ?? 'unknown'}`;
    progress(`  ${reason}`);
    return { ok: false, findings: [], log: '', reason };
  }

  const before = await changedFiles(input.dir);
  const run = await input.harness.run(input.dir, {
    instruction: reviewPrompt(input),
    failureOutput: '',
  });
  const after = await changedFiles(input.dir);

  if (after.join('\n') !== before.join('\n')) {
    const reason = 'the review session modified the workspace; its findings are discarded';
    progress(`  ${reason}`);
    return { ok: false, findings: [], log: run.log, reason };
  }

  const findings = parseReviewFindings(assistantText(run.log));
  if (findings === null) {
    // Exiting zero is not the same as answering. Measured: opencode failed to
    // resolve a model, printed an APIError and exited zero, and an earlier
    // version reported "no structural findings" — a clean bill of health from a
    // review that never ran.
    const line = run.log.split('\n').find((l) => l.trim()) ?? 'no output';
    const reason = `the review returned no findings object: ${line.trim().slice(0, 200)}`;
    progress(`  repo-wide review could not run: ${line.trim().slice(0, 120)}`);
    return { ok: false, findings: [], log: run.log, reason };
  }

  progress(
    findings.length === 0
      ? '  repo-wide review: no structural findings'
      : `  repo-wide review: ${findings.length} finding(s)`,
  );
  return { ok: true, findings, log: run.log };
}

/**
 * What the model actually said, pulled out of opencode's event stream.
 *
 * `--format json` emits newline-delimited events and puts the reply inside
 * `part.text`, JSON-escaped — so a findings object arrives on the wire as
 * `{\"findings\": []}` and a scan of the raw log for `{"findings"` never
 * matches. That is why a review that answered correctly was reported as having
 * produced no output.
 *
 * Falls back to the raw log when there are no events, which keeps two things
 * working: a harness that prints plainly, and an error line like
 * `error: {"name":"APIError"…}` — which must still reach the caller as "did not
 * answer" rather than be swallowed into an empty string.
 */
export function assistantText(log: string): string {
  const said: string[] = [];
  let sawEvent = false;

  for (const line of log.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const event = JSON.parse(trimmed) as { type?: unknown; part?: { text?: unknown } };
      if (typeof event.type !== 'string') continue;
      sawEvent = true;
      if (event.type === 'text' && typeof event.part?.text === 'string') said.push(event.part.text);
    } catch {
      /* a line of JSON that is not an event; the fallback below covers it */
    }
  }
  return sawEvent ? said.join('\n') : log;
}

/** Files the workspace reports as changed, so "it edited nothing" can be checked. */
async function changedFiles(dir: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', [
    '-C', dir, 'status', '--porcelain', '--', '.', ':(exclude)**/node_modules/**',
  ]).catch(() => ({ stdout: '' }));
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    // opencode writes `.omo/run-continuation/ses_*.json` on every run whatever
    // the permissions say. Counting its own bookkeeping as an edit discarded a
    // review in which no source file had changed at all.
    .filter((line) => !line.slice(2).trim().replace(/^"|"$/g, '').startsWith('.omo/'));
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
