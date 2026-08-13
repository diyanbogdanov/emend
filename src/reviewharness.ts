/**
 * The repo-wide review: what a structured-edit pass structurally cannot see.
 *
 * There are now two reviews, and the split is not arbitrary — it follows from
 * what each one is able to say.
 *
 * `reviewMigration` proposes *edits*, and `reviewGate` in gate.ts confines them
 * to lines the migration changed. That gate exists because an unanchored review
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

import type { Harness } from './harness.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Ordered by the priority `reviewPrompt` sets, because that is the order the
 * model was asked to weigh them in: duplication first — the finding a diff-only
 * reviewer can never make — down to size, which is a measurement more than a
 * judgement.
 *
 * This list and the prompt's are one thing in two places, and drifted apart
 * once: the prompt asked for `complexity` and `atomicity` while this knew four
 * severities, so the two categories it rated most interesting were the two it
 * could not report. A test now reads the accepted set out of the prompt.
 */
export type ReviewSeverity =
  | 'duplication'
  | 'structural'
  | 'complexity'
  | 'boundary'
  | 'atomicity'
  | 'size';

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
  'duplication',
  'structural',
  'complexity',
  'boundary',
  'atomicity',
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
 * The last `{"findings": [...]}` object in the log, validated entry by entry.
 *
 * Tolerant on the way in and strict on the way out. A harness log is a
 * transcript, not a response — the JSON arrives surrounded by tool calls and
 * commentary, and the last object is the one that concluded. An entry missing a
 * field is dropped, because a partial finding rendered into a PR body reads as
 * authoritative regardless.
 *
 * `null` when the model did not answer the question, which is not the same as
 * answering that there is nothing to report — the distinction this whole file
 * turns on. Two things count as not answering: no findings object at all, and a
 * findings object none of whose entries survived validation.
 *
 * The second is the one that had to be learned. Dropping entries that fail
 * validation reads as tidying, but a filter that empties a non-empty list has
 * silently converted "I did not understand this answer" into "there was nothing
 * to report" — and those are opposite claims. It happened: the contract review
 * asked for one shape and was parsed for another, so a review naming the exact
 * regression it existed to catch came back as a clean bill of health.
 */
function parseFindings<T>(log: string, valid: (entry: Record<string, unknown>) => boolean): T[] | null {
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
    const kept = list.filter((f) => valid(f as Record<string, unknown>));
    if (kept.length === 0 && list.length > 0) return null;
    return kept as T[];
  }
  // No findings object at all — the harness did not answer the question.
  // Measured live: opencode failed to resolve a model, printed an APIError,
  // exited zero, and this reported "no structural findings".
  return null;
}

/** The repo-wide migration review: structural regressions, in four severities. */
export function parseReviewFindings(log: string): ReviewFinding[] | null {
  return parseFindings<ReviewFinding>(log, (r) => {
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

/**
 * The categories a redirected HTTP call can change behaviour in.
 *
 * Kept distinct from the migration review's severities rather than flattened
 * into them, because the category *is* the finding here. "scope" tells a reader
 * the replacement returns different rows — the failure that a matching response
 * shape hides, and the one that made a Resend fix wrong. Calling that
 * "structural" would discard the only part worth acting on.
 */
export type ContractConcern = 'scope' | 'pagination' | 'ordering' | 'errors' | 'collateral';

export interface ContractFinding {
  kind: ContractConcern;
  /** Repo-relative, so a reader can open it. */
  path: string;
  /** What changed about the behaviour, and what it protected. */
  detail: string;
}

const CONCERNS: ReadonlySet<string> = new Set([
  'scope',
  'pagination',
  'ordering',
  'errors',
  'collateral',
]);

/** The behaviour review of a redirected call: does it still return the same rows? */
export function parseContractFindings(log: string): ContractFinding[] | null {
  return parseFindings<ContractFinding>(log, (r) => {
    return (
      typeof r['kind'] === 'string' &&
      CONCERNS.has(r['kind']) &&
      typeof r['path'] === 'string' &&
      r['path'] !== '' &&
      typeof r['detail'] === 'string' &&
      r['detail'] !== ''
    );
  });
}

export interface HarnessReview<T = ReviewFinding> {
  ok: boolean;
  findings: T[];
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
export async function reviewSession<T = ReviewFinding>(input: {
  harness: Harness;
  dir: string;
  pkg: string;
  fromVersion: string;
  toVersion: string;
  diff: string;
  /** An instruction for a review that is not about a dependency upgrade. */
  prompt?: string;
  /**
   * How to read the answer, which has to travel with the question.
   *
   * A custom `prompt` asks for a different shape, and the default parser
   * silently discarded every finding of it — so the two are one decision, not
   * two independent knobs.
   */
  parse?: (log: string) => T[] | null;
  progress?: (message: string) => void;
}): Promise<HarnessReview<T>> {
  const progress = input.progress ?? (() => {});
  const available = await input.harness.available();
  if (!available.ok) {
    const reason = `review harness unavailable: ${available.reason ?? 'unknown'}`;
    progress(`  ${reason}`);
    return { ok: false, findings: [], log: '', reason };
  }

  const before = await changedFiles(input.dir);
  const run = await input.harness.run(input.dir, {
    instruction: input.prompt ?? reviewPrompt(input),
    failureOutput: '',
  });
  const after = await changedFiles(input.dir);

  if (after.join('\n') !== before.join('\n')) {
    const reason = 'the review session modified the workspace; its findings are discarded';
    progress(`  ${reason}`);
    return { ok: false, findings: [], log: run.log, reason };
  }

  const parse = input.parse ?? (parseReviewFindings as (log: string) => T[] | null);
  const findings = parse(assistantText(run.log));
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
  const order: ReviewSeverity[] = [
    'duplication',
    'structural',
    'complexity',
    'boundary',
    'atomicity',
    'size',
  ];
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

/**
 * A review of a redirected call, asking the one question its author cannot.
 *
 * Measured twice, and the same shape both times: a driven session picked a
 * plausible replacement route, justified it well, compiled, and quietly changed
 * what came back. On kubespec.dev it swapped a git-refs route for the Repos
 * Tags API, which paginates at thirty where the original did not. On
 * activepieces it replaced `/audiences/{id}/contacts` with `/contacts` — the
 * same response *shape*, so the code parsed it unchanged — and deleted the
 * audience gating around it, turning a picker scoped to one audience into one
 * listing every contact in the account.
 *
 * Neither is visible to a build: a URL is a string and compiles whatever it
 * says. Neither was caught by the session that made it, because it had already
 * argued itself into the change. So this asks a session that never saw that
 * reasoning, and asks it about behaviour rather than about quality — the
 * existing review is about duplication and structure, which is a different job.
 *
 * The question is deliberately narrow. Not "is this good" but "does the code do
 * the same thing", because the failures were all the same kind: the call still
 * works, and it returns a different set of things.
 */
export function contractReviewPrompt(input: {
  host: string;
  route: string;
  description: string;
  diff: string;
}): string {
  return [
    `A call in this repository reached \`${input.route}\` on ${input.host}, which that vendor's own description no longer contains, and the change below redirects it.`,
    '',
    'Judge one thing: does the code still do what it did, apart from reaching a route that exists?',
    '',
    'Read the changed files and the code around them before answering. The diff is where to start, not what to judge — what a call returns is decided by the code that consumes it, which the diff may not show.',
    '',
    `The description is at ${input.description}. It is the authority on what each route returns.`,
    '',
    'Report a finding for any of these, and nothing else:',
    '- `scope` — the replacement returns a different SET of records. A filter, a parent resource or a query parameter that scoped the old call and is absent from the new one. This is the failure most easily missed, because the response *shape* can be identical while the rows are not.',
    '- `pagination` — the routes differ in default page size, page limit, or whether they page at all, and the caller does not page.',
    '- `ordering` — results arrive in a different order and the caller depends on the order.',
    '- `errors` — the new route signals absence or failure differently, and the caller branches on it.',
    '- `collateral` — a guard, an early return or a piece of state was removed alongside the URL. Say what it protected.',
    '',
    'Do not report style, naming, types, or whether the route choice is elegant. Do not report that the change is correct — silence means that.',
    '',
    '```diff',
    input.diff.slice(0, 12_000),
    '```',
    '',
    'Answer with a JSON object on its own line: {"findings": [{"kind": "...", "path": "...", "detail": "..."}]}. An empty array means the behaviour is unchanged, and say so only if you read the consuming code.',
  ].join('\n');
}

/**
 * Render behaviour concerns for a terminal or a pull request body.
 *
 * Separate from `renderReviewFindings` because the reader's next action is
 * different. A structural note is advice to weigh; a `scope` concern says the
 * change returns different rows than it used to, which is a reason not to ship
 * it — so the concern leads the line rather than trailing it.
 */
export function renderContractFindings(findings: ContractFinding[]): string {
  if (findings.length === 0) return '';
  const order: ContractConcern[] = ['scope', 'collateral', 'pagination', 'ordering', 'errors'];
  const sorted = [...findings].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return sorted.map((f) => `      ${f.kind} · ${f.path} — ${f.detail}`).join('\n');
}
