import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
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
    '- You MUST open files before answering. A conclusion drawn from the path list alone is worthless: duplication and misplaced logic are only visible in the contents. Start with the files the diff touches and their neighbours in the tree.',
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
 * A reader over a real checkout, backed by git's own idea of what is in it.
 *
 * `git ls-files` rather than a directory walk: it already excludes node_modules,
 * build output and anything gitignored, and it cannot wander outside the
 * repository. The list it returns is also the allowlist `reviewRepository` reads
 * against, so a model asking for `../../.ssh/id_rsa` gets told it is not a file
 * in this repository.
 */
export function repoReader(dir: string): RepoReader {
  let cached: string[] | null = null;
  return {
    async list() {
      if (cached) return cached;
      const { stdout } = await execFileAsync('git', ['-C', dir, 'ls-files'], {
        maxBuffer: 32 * 1024 * 1024,
      }).catch(() => ({ stdout: '' }));
      cached = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      return cached;
    },
    async read(file) {
      const listed = await this.list();
      if (!listed.includes(file)) return null;
      return readFile(path.join(dir, file), 'utf8').catch(() => null);
    },
  };
}

/** Read-only access to a checkout. There is deliberately no write counterpart. */
export interface RepoReader {
  /** Repo-relative source paths, excluding dependencies and build output. */
  list(): Promise<string[]>;
  /** File contents, or null when the path is not one `list` offered. */
  read(file: string): Promise<string | null>;
}

const MAX_ROUNDS = 4;
const MAX_BYTES = 120_000;
const MAX_PER_ROUND = 6;

/**
 * Review the repository with a model that can ask for files.
 *
 * Deliberately not a coding harness. opencode was the obvious tool and was the
 * wrong one twice over: it resolves its model from the host's own config — which
 * on a Copilot-authenticated machine silently meant Claude, contrary to running
 * on open weights — and its read-only mode had to be *verified afterwards*
 * because the permission was configuration rather than capability.
 *
 * Here read-only is structural. The loop offers `list` and `read` and there is no
 * write tool to deny, so there is nothing to verify and nothing to revert. It
 * also needs no tool-calling API: the model asks in text, which keeps it working
 * on any provider and any open-weight model.
 */
export async function reviewRepository(
  ask: (messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>) =>
    Promise<{ ok: boolean; content: string; error?: string }>,
  reader: RepoReader,
  input: { pkg: string; fromVersion: string; toVersion: string; diff: string },
  progress: (message: string) => void = () => {},
): Promise<HarnessReview> {
  const files = await reader.list();
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: reviewPrompt(input) },
    {
      role: 'user',
      content: [
        'Files in this repository:',
        files.join('\n'),
        '',
        `Ask for what you need with lines of the form \`READ: <path>\` (at most ${MAX_PER_ROUND} per reply, nothing else in the message).`,
        'When you have read enough, reply with the JSON object and nothing else.',
      ].join('\n'),
    },
  ];

  const transcript: string[] = [];
  let budget = MAX_BYTES;
  let hasRead = false;
  let pushedBack = false;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const reply = await ask(messages);
    if (!reply.ok) {
      return { ok: false, findings: [], log: reply.error ?? 'the review model failed', reason: reply.error ?? 'the review model failed' };
    }
    transcript.push(reply.content);

    const parsed = parseReviewFindings(reply.content);
    // An answer given without opening a file is an answer about the file list.
    // Measured live: GLM 5.2 concluded "no structural findings" on the first
    // reply, having read nothing — and the repository it was judging contained a
    // helper duplicating one in the diff and feature logic in a shared module.
    // Neither is visible from a list of paths. One push-back, then take what
    // comes: refusing repeatedly would turn a thin review into no review.
    if (parsed !== null && !hasRead && !pushedBack && round < MAX_ROUNDS) {
      pushedBack = true;
      messages.push({ role: 'assistant', content: reply.content });
      messages.push({
        role: 'user',
        content:
          'You have not opened any files. Duplication and misplaced logic cannot be seen from a list of paths. ' +
          'Read the files the diff touches and the ones nearest them in the tree, then answer.',
      });
      continue;
    }
    if (parsed !== null) {
      progress(
        parsed.length === 0
          ? '  repo-wide review: no structural findings'
          : `  repo-wide review: ${parsed.length} finding(s)`,
      );
      return { ok: true, findings: parsed, log: transcript.join('\n---\n') };
    }

    const wanted = [...reply.content.matchAll(/^\s*READ:\s*(\S+)\s*$/gm)]
      .map((m) => m[1] ?? '')
      .filter(Boolean)
      .slice(0, MAX_PER_ROUND);
    if (wanted.length === 0) break;

    const delivered: string[] = [];
    for (const file of wanted) {
      // `list` is the allowlist. A path it never offered is not read, whatever
      // the model asked for — the one place traversal could happen.
      if (!files.includes(file)) {
        delivered.push(`## ${file}\n(not a file in this repository)`);
        continue;
      }
      const content = (await reader.read(file)) ?? '';
      const slice = content.slice(0, Math.max(0, budget));
      budget -= slice.length;
      delivered.push(`## ${file}\n\`\`\`\n${slice}\n\`\`\``);
    }
    hasRead = true;
    progress(`  repo-wide review: read ${wanted.length} file(s), round ${round}/${MAX_ROUNDS}`);
    messages.push({ role: 'assistant', content: reply.content });
    messages.push({
      role: 'user',
      content:
        budget <= 0
          ? `${delivered.join('\n\n')}\n\nThe reading budget is spent. Reply with the JSON object now.`
          : delivered.join('\n\n'),
    });
  }

  // Out of rounds without an answer. Not the same as finding nothing.
  const reason = `the review did not produce a findings object within ${MAX_ROUNDS} rounds`;
  progress(`  repo-wide review could not conclude: ${reason}`);
  return { ok: false, findings: [], log: transcript.join('\n---\n'), reason };
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
