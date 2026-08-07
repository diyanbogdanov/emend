/**
 * The migration agent: proposes edits when the deterministic planner cannot.
 *
 * Design follows two findings from the literature rather than the obvious
 * "hand the repo to an agent" approach:
 *
 *  - Byam (arXiv 2505.07522) — end-to-end LLM dependency migration fully fixed
 *    only 27% of builds, and improved markedly when given the API diff, the
 *    failing lines, and compiler feedback. So the model is handed exactly those
 *    three things, and is invoked inside a verify-and-repair loop.
 *  - BigBag (arXiv 2606.24446) — generating one reusable, validated
 *    transformation beats re-improvising a patch per repository. So the model
 *    returns a structured edit set, not a freeform patch.
 *
 * The model never touches the filesystem. It proposes `find`/`replace` pairs;
 * Emend locates them, rejects anything ambiguous or absent, applies the rest,
 * and lets the existing verification decide. A hallucinated edit fails closed.
 */

import type { CallSite, Finding, SurfaceChange } from '../types.ts';
import type { LlmConfig } from './providers.ts';
import { chat, extractJson, type ChatMessage } from './client.ts';

export interface TextEdit {
  file: string;
  /** Exact, unique substring to replace. Emend locates it; the model does not. */
  find: string;
  replace: string;
  reason: string;
}

export interface AgentProposal {
  ok: boolean;
  edits: TextEdit[];
  rationale: string;
  /** The model's own confidence, recorded for the PR body — never trusted as a gate. */
  modelConfidence: 'high' | 'medium' | 'low';
  error?: string;
  usage?: { promptTokens: number; completionTokens: number };
}

export interface AgentContext {
  /** Provides the package and version pair. Its own `change` is not special. */
  finding: Finding;
  /**
   * Every unresolved change in this upgrade, each with the call sites it hit.
   *
   * A version bump is atomic, so the model must see all of it. Describing one
   * change while supplying every call site is worse than useless: asked to fix
   * `ZodString.email` and shown a compiler error about `z.record`, a model will
   * confidently edit `email()` three times and never touch the real break.
   */
  changes: Array<{ change: SurfaceChange; sites: CallSite[] }>;
  /** repo-relative path -> full source text. */
  sources: Map<string, string>;
  /** Symbols available in the target version, to ground replacements in reality. */
  candidateSymbols: string[];
  /**
   * Compiler and test output as it stands right now — the authority on what is
   * still broken.
   *
   * Separate from the attempt history because it exists before the model has
   * tried anything: the deterministic phase has already run and left the build
   * red. Passing it as a zero-edit "previous attempt" reads as "you tried
   * nothing and it did not work" the moment real attempts accumulate.
   */
  failureOutput?: string;
  /**
   * Every failed attempt so far, oldest first.
   *
   * Carrying only the most recent one lets attempt 3 re-propose what attempt 1
   * already tried, because it cannot see that it did. A bounded retry budget is
   * then spent oscillating between two wrong fixes rather than reaching a third.
   */
  previousAttempts?: Array<{
    edits: TextEdit[];
    errors: string;
  }>;
}

/**
 * Input for the tightening repair, which is a different task from a migration.
 *
 * Its own type rather than an optional mode on `AgentContext`. The two tasks
 * want opposite things — migration says "change only what the API requires" and
 * "prefer naming the type", tightening requires the body rewritten and the
 * annotation left off — and the API diff and candidate symbols that a migration
 * cannot work without are meaningless here: every remaining error is about a
 * value's real type, which the compiler has already named. Sharing one context
 * meant the caller assembled both, and the tightening prompt silently discarded
 * them.
 */
export interface TighteningContext {
  /** Provides the package and version pair for the prompt's preamble. */
  finding: Finding;
  /** repo-relative path -> source text, with the annotations already removed. */
  sources: Map<string, string>;
  /** Compiler output from the stripped-but-unrepaired state. */
  errors: string;
}

/**
 * Input for the review pass over a migration that already verifies.
 *
 * Its own type for the same reason `TighteningContext` is: the tasks disagree.
 * Migration says "change only what the API requires"; review is asked to
 * restructure. What review needs and the others do not is the diff — the
 * question is whether *this change* is worth merging, which cannot be answered
 * from the files alone.
 *
 * `deprecationGaps` is measured before the model is asked, never inferred. A
 * migration can report "X is deprecated" and ship without removing a single use
 * of X, and no phase of verification objects, because deprecated code compiles.
 */
export interface ReviewContext {
  finding: Finding;
  /** repo-relative path -> source text, with the migration applied. */
  sources: Map<string, string>;
  /** What the migration did, as a unified diff. */
  diff: string;
  /** Deprecated symbols still imported, one per line. Empty when there are none. */
  deprecationGaps: string;
  /** Symbols available in the target version, to ground a replacement in reality. */
  candidateSymbols: string[];
}

/**
 * The output contract, shared by every prompt.
 *
 * Kept in one constant because `proposeEdits` parses one shape and one shape
 * only: a prompt that drifted here would produce edits the parser silently drops.
 */
const RESPONSE_SHAPE = `Respond with exactly this shape:
{
  "edits": [{"file": "src/x.ts", "find": "<exact unique substring>", "replace": "<replacement>", "reason": "<short why>"}],
  "rationale": "<one or two sentences on the overall change>",
  "confidence": "high" | "medium" | "low"
}`;

/**
 * How to handle a value whose type is a union, in any prompt that can meet one.
 *
 * Shared rather than repeated. #1 disclosed the gap this closes — the rule lived
 * only in the tightening prompt, so a migration that had to narrow a union wrote
 * `Number(value)` unguided, and the recharts case reproduces it: the tooltip
 * formatter takes `ValueType | undefined`, so a missing value renders `$NaN`
 * while typechecking and passing every test. Two copies of a rule this specific
 * drift, and the copy that drifts is the one nobody is reading.
 */
export const NARROWING_RULE = `Handle the real type. Choose the form by what the compiler says the type actually is:
   a. The type is a union with more than one non-undefined member (for example \`ValueType\`, which is \`number | string | ReadonlyArray<number | string>\`) — you MUST narrow with a runtime check, and every branch must still produce a sensible result:
      \`typeof value === 'number' ? value.toFixed(1) : String(value ?? '')\`
      The branch that is NOT the numeric one must pass its value through, typically with \`String(...)\`. Do not funnel it back through \`Number(...)\`: \`Number('n/a')\` is \`NaN\`, so a label that was meant to read "n/a" reaches the user as "NaN". A \`typeof\` check whose else branch is \`Number(value)\` is the same silent bug wearing a disguise.
   b. Only \`undefined\` is the problem and the remaining type is already what you need — guard it:
      \`value?.toFixed(1) ?? \'\'\`
   Blanket coercion such as \`Number(value ?? 0)\` or \`Number(value)\` is NOT acceptable in case (a). It compiles, so nothing will object to it, but it renders a real string as "0" and a missing value as "NaN" — a silent behaviour change no test catches and no reviewer sees. Only reach for a coercion when the union has exactly one non-undefined member.`;

export const MIGRATION_SYSTEM_PROMPT = `You are a precise TypeScript migration engine.

You are given the API changes in a dependency upgrade, the exact lines in a codebase that use them, and the symbols available in the new version. Produce the minimal source edits that make the code correct under the new version.

Rules you must follow:
1. Output ONLY a JSON object. No prose, no markdown fences.
2. Each edit's "find" MUST be an exact substring copied character-for-character from the provided source, and MUST be unique within that file. Include surrounding context to make it unique.
3. Change only what the API changes require. Do not reformat, rename variables, add comments, or refactor.
   The deprecations listed above ARE required. A deprecated symbol never produces a compiler error, so nothing downstream will object if you leave it — and a migration that reports "X is deprecated" and ships with X still in the code has not done what it said. Replace each one with its current equivalent from the available-symbols list. If a deprecation genuinely has no replacement there, leave it and say so in "rationale".
4. Only use symbols that appear in the provided list of available symbols. Never invent an API.
5. If you cannot determine a correct edit, return an empty "edits" array and explain why in "rationale". An empty result is far better than a wrong one.
6. When compiler output from a failed attempt is provided, it is the authoritative statement of what is still broken. Fix the errors it reports. Do not edit call sites it does not complain about, however plausible the change looks.
7. The list of API changes is derived from a type-declaration diff and can be incomplete. If the compiler reports an error the list does not explain, fix it anyway using the error's own description of the expected type. Do not decline solely because an error is absent from the list.
8. Prefer the strongest type that compiles, in this order. First, name the constraint with a type the package exports — the error text usually names it and it is usually in the available-symbols list, sometimes under a different export name; prefer (value: TooltipValueType | undefined) => Number(value ?? 0).toFixed(1). Second, omit the annotation and let it be inferred from context. Only if neither compiles, use any or a cast, and say so in that edit's "reason". Never use @ts-ignore or @ts-expect-error. Getting to green matters more than getting there elegantly, but try the stronger forms first.
9. ${NARROWING_RULE}

${RESPONSE_SHAPE}`;

/**
 * The review pass: it verifies, but is it worth merging?
 *
 * Adapted from the "thermo-nuclear code quality review" criteria, narrowed to
 * what this harness can enforce. Two findings from a human review of a real
 * Emend pull request shaped it, and neither could fail verification:
 *
 *  - Emend reported `Cell` as *deprecated*, titled its commit "migrate `Cell`",
 *    and removed no use of `Cell`. It fixed the type errors the version bump
 *    caused and left the deprecated API in place.
 *  - The migration repeated the same coercion at nine call sites. The reviewer
 *    extracted one module and the diff got smaller.
 */
export const REVIEW_SYSTEM_PROMPT = `You are a demanding code reviewer with commit rights, reviewing a dependency migration that already compiles and passes its tests.

Passing is the floor, not the goal. Decide whether this diff leaves the codebase better or merely green, and fix it where it does not.

Rules you must follow:
1. Output ONLY a JSON object. No prose, no markdown fences.
2. Each edit's "find" MUST be an exact substring copied character-for-character from the provided source, and MUST be unique within that file. Include surrounding context to make it unique.
3. Behaviour must not change. This is a restructuring pass. The one exception: replacing a deprecated API with its supported equivalent is the migration finishing its job, not a behaviour change.
4. Finish the migration first. If you are told a deprecated symbol is still imported, removing it is the highest-priority edit in this pass. A migration that reports "X is deprecated" and still uses X has not done what it said. Use the package's supported replacement; if there is none, leave it and say so in "rationale".
5. Then look for the move that deletes complexity rather than rearranging it:
   - The same edit repeated at three or more call sites is a missing helper. Extract it once, in the layer that owns that boundary, and call it.
   - Conditionals, flags or special cases the diff added where a better shape would need none.
   - Casts, \`any\`, \`unknown\` or new optionality that hides an invariant instead of stating it.
   - A wrapper or indirection that does not earn the extra hop.
6. Do not reformat, rename, or restructure code the migration did not touch. Out-of-scope churn buries the change under noise and is the fastest way for a reviewer to reject an otherwise good pull request.
   Comments are the exception, and only when the migration made one false. A comment naming the old version, or describing behaviour the migration changed, is now wrong and correcting it finishes the job. Rewrite it to describe what the code does now, in a form that reads correctly on its own — do not repeat a sentence that already appears beside it, and do not leave a fragment of the old one. A comment the migration did not falsify stays exactly as it is.
7. When a coercion has to stand in for missing data, prefer a value the caller can detect over one it cannot. \`Number(x ?? 0)\` renders a real string as "0", which no test objects to and no reader spots; returning null, or a sentinel the formatter understands, keeps the absence visible.
8. If the diff is already good, return an empty "edits" array and say why. That is a valid and useful answer — a pass that invents work to look busy is worse than one that declines.

Prefer a small number of high-conviction structural improvements to an exhaustive list of nits.

${RESPONSE_SHAPE}`;

/**
 * The follow-up task: the migration is green and the `any` annotations have been
 * stripped, so the parameters now infer their real types. Whatever the compiler
 * reports next is code that only ever compiled because `any` disabled checking.
 *
 * A separate prompt rather than a flag on the migration one. The two tasks
 * genuinely disagree — migration forbids touching the body and prefers naming a
 * type, tightening requires the body to change and forbids naming a type — and
 * a model handed both sets of rules at once satisfies the wrong one.
 */
export const TIGHTENING_SYSTEM_PROMPT = `You are a precise TypeScript engine performing a follow-up cleanup task.

A dependency migration has already been completed and verified. The \`: any\` annotations on its function parameters were then removed, so those parameters now infer their real types from context. That exposed the errors you are given: code that compiled only because \`any\` had switched checking off.

Your job is to make that code correct at the point of use, leaving the parameters inferred.

Rules you must follow:
1. Output ONLY a JSON object. No prose, no markdown fences.
2. Each edit's "find" MUST be an exact substring copied character-for-character from the provided source, and MUST be unique within that file. Include surrounding context to make it unique.
3. The source files you are shown are the CURRENT state, with the annotations ALREADY REMOVED. Copy "find" strings from what you are shown, never from what the code looked like before.
4. NEVER re-add a parameter type annotation — not \`: any\`, and not a named type either. The parameter must stay inferred. Re-adding one undoes the entire point of this task.
5. NEVER use a type assertion (\`as X\`), \`@ts-ignore\`, or \`@ts-expect-error\`.
6. Editing the function BODY is exactly what this task requires. It is not a refactor and it is not out of scope. Change as much of the body as the fix needs, and nothing beyond that.
7. ${NARROWING_RULE}
8. The compiler output is the authoritative statement of what is broken. Fix what it reports, and do not edit code it does not complain about.
9. If an error cannot be fixed without breaking one of these rules, leave it alone. A partial edit set is fine and expected — a file still failing simply keeps its original annotations.

${RESPONSE_SHAPE}`;

function describeChange(change: SurfaceChange): string {
  const lines = [
    `Symbol:      ${change.path}`,
    `Change kind: ${change.kind}`,
    `Severity:    ${change.severity} (detection confidence: ${change.confidence})`,
  ];
  if (change.before) lines.push(`Old type:    ${change.before.slice(0, 1200)}`);
  if (change.after) lines.push(`New type:    ${change.after.slice(0, 1200)}`);
  else lines.push('New type:    (symbol no longer exists)');
  // The declaration's own instruction, when it gives one. This outranks the
  // candidate symbol list, because the replacement is frequently not a symbol
  // at all and no list can express it.
  if (change.guidance) lines.push(`The library says: ${change.guidance}`);
  return lines.join('\n');
}

function describeSites(sites: CallSite[]): string {
  return sites
    .map((s) => `- ${s.file}:${s.line}:${s.column}  ${s.text}`)
    .join('\n');
}

export function buildUserPrompt(ctx: AgentContext): string {
  const { finding } = ctx;
  const parts: string[] = [];

  parts.push(`# Dependency upgrade`);
  parts.push(`${finding.pkg}: ${finding.fromVersion} -> ${finding.toVersion}`);
  parts.push('');
  parts.push(
    `# API changes to resolve (${ctx.changes.length}), each with its call sites`,
  );
  parts.push(
    '_Derived from a declaration diff, and possibly incomplete. Entries with no ' +
      'call sites listed were added because the compiler named them._',
  );
  ctx.changes.forEach(({ change, sites }, i) => {
    parts.push(`## ${i + 1}. ${change.path}`);
    parts.push(describeChange(change));
    parts.push('Call sites:');
    parts.push(describeSites(sites));
    parts.push('');
  });

  if (ctx.candidateSymbols.length > 0) {
    // Ordered by relevance to the broken symbols, so truncation drops the least
    // likely replacements rather than an alphabetical tail.
    parts.push(
      `# Symbols available in ${finding.pkg}@${finding.toVersion} (most relevant first)`,
    );
    parts.push(ctx.candidateSymbols.slice(0, 120).join('\n'));
    parts.push('');
  }

  parts.push('# Source files');
  for (const [file, content] of ctx.sources) {
    parts.push(`## ${file}`);
    parts.push('```typescript');
    parts.push(content);
    parts.push('```');
    parts.push('');
  }

  if (ctx.failureOutput?.trim()) {
    parts.push('# Currently broken — the authority on what to fix');
    parts.push('```');
    // The compiler output is the most reliable thing in this prompt: it states
    // exactly what is still wrong, in a form that cannot be misremembered.
    // Truncating it hides failures the model is then blamed for not fixing.
    parts.push(ctx.failureOutput.slice(0, 40_000));
    parts.push('```');
    parts.push(
      'Fix exactly what this output reports, plus the deprecations listed above — those never appear here, because deprecated code compiles. Do not edit anything else, however plausible the change looks.',
    );
    parts.push('');
  }

  const attempts = ctx.previousAttempts ?? [];
  if (attempts.length > 0) {
    parts.push(`# Your previous attempts FAILED verification (${attempts.length})`);
    // Every attempt's edits are listed, because those are what must not be
    // repeated. Their error output is not: it is superseded by the current
    // failure above, and reproducing each one would spend the context that
    // output needs.
    attempts.forEach(({ edits, errors }, i) => {
      parts.push(`## Attempt ${i + 1} — rejected, do not propose these again`);
      parts.push('```json');
      parts.push(JSON.stringify(edits, null, 2));
      parts.push('```');
      // A short outcome, not the full output: what is broken now is stated once,
      // above, and repeating a superseded copy per attempt would crowd it out.
      if (errors.trim()) parts.push(`Outcome: ${errors.slice(0, 500)}`);
    });
    parts.push(
      'Propose a DIFFERENT fix. Repeating an edit listed above will fail the same way. Note the source shown above is the ORIGINAL, unmodified file — your new edits apply to that, not to any previous attempt.',
    );
    parts.push('');
  }

  parts.push('Produce the JSON now.');
  return parts.join('\n');
}

/**
 * The tightening prompt: compiler output and the current sources, nothing else.
 *
 * Sending the API diff and the candidate symbol list as well would cost context
 * and invite the model to "fix" call sites the compiler is happy with, so
 * `TighteningContext` does not carry them at all.
 */
export function buildTighteningPrompt(ctx: TighteningContext): string {
  const { finding, errors } = ctx;
  const parts: string[] = [];

  parts.push('# What just happened');
  parts.push(
    `${finding.pkg}: ${finding.fromVersion} -> ${finding.toVersion} migrated and verified. ` +
      'The `any` parameter annotations were then removed, and these errors appeared.',
  );
  parts.push('');

  parts.push('# Compiler output (authoritative)');
  parts.push('```');
  // Never truncated below the migration path's allowance: a repair judged on
  // errors it was not shown is the failure mode this whole step exists to avoid.
  parts.push(errors.slice(0, 40_000));
  parts.push('```');
  parts.push('');

  parts.push('# Source files — CURRENT state, annotations already removed');
  for (const [file, content] of ctx.sources) {
    parts.push(`## ${file}`);
    parts.push('```typescript');
    parts.push(content);
    parts.push('```');
    parts.push('');
  }

  parts.push(
    'Produce the JSON now. Fix the bodies; leave the parameters inferred.',
  );
  return parts.join('\n');
}

function isTextEdit(value: unknown): value is TextEdit {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e['file'] === 'string' &&
    typeof e['find'] === 'string' &&
    typeof e['replace'] === 'string' &&
    e['find'] !== ''
  );
}

/** Propose the edits that carry a codebase onto the new version of a dependency. */
export async function proposeEdits(
  config: LlmConfig,
  ctx: AgentContext,
): Promise<AgentProposal> {
  return propose(config, MIGRATION_SYSTEM_PROMPT, buildUserPrompt(ctx));
}

/**
 * Propose the edits that repair what removing the `any` annotations exposed.
 *
 * Separate from `proposeEdits` because only the prompt differs — everything
 * after the request is one shape, parsed one way.
 */
export async function proposeTightening(
  config: LlmConfig,
  ctx: TighteningContext,
): Promise<AgentProposal> {
  return propose(config, TIGHTENING_SYSTEM_PROMPT, buildTighteningPrompt(ctx));
}

/**
 * The review prompt: what the migration did, what it left undone, the files.
 *
 * Unlike the tightening prompt this carries the candidate symbols, because
 * finishing a deprecation means naming what replaced the symbol — and unlike
 * either of the others it carries the diff, because "is this worth merging"
 * cannot be answered from the files alone.
 */
export function buildReviewPrompt(ctx: ReviewContext): string {
  const { finding } = ctx;
  const parts: string[] = [];

  parts.push('# What was migrated');
  parts.push(`${finding.pkg}: ${finding.fromVersion} -> ${finding.toVersion}. It verifies.`);
  parts.push('');

  if (ctx.deprecationGaps) {
    parts.push('# Unfinished: deprecated symbols still imported');
    parts.push('_Measured from the files as they stand, not inferred. Rule 4: these come first._');
    parts.push(ctx.deprecationGaps);
    parts.push('');
    if (ctx.candidateSymbols.length > 0) {
      parts.push(`Available in ${finding.pkg}@${finding.toVersion} (most relevant first):`);
      parts.push(ctx.candidateSymbols.slice(0, 60).join('\n'));
      parts.push('');
    }
  }

  parts.push('# The diff under review');
  parts.push('```diff');
  parts.push(ctx.diff.slice(0, 30_000));
  parts.push('```');
  parts.push('');

  parts.push('# Source files — CURRENT state, with the migration applied');
  for (const [file, content] of ctx.sources) {
    parts.push(`## ${file}`);
    parts.push('```typescript');
    parts.push(content);
    parts.push('```');
    parts.push('');
  }

  parts.push('Produce the JSON now. An empty edit list is a valid answer.');
  return parts.join('\n');
}

/**
 * Propose the edits that make an already-green migration worth merging.
 *
 * Separate from `proposeEdits` for the same reason `proposeTightening` is: only
 * the prompt differs, and the three prompts contradict each other.
 */
export async function proposeReview(
  config: LlmConfig,
  ctx: ReviewContext,
): Promise<AgentProposal> {
  return propose(config, REVIEW_SYSTEM_PROMPT, buildReviewPrompt(ctx));
}

async function propose(
  config: LlmConfig,
  system: string,
  user: string,
): Promise<AgentProposal> {
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  const res = await chat(config, messages, { jsonMode: true });
  if (!res.ok) {
    return {
      ok: false,
      edits: [],
      rationale: '',
      modelConfidence: 'low',
      error: res.error ?? 'request failed',
    };
  }

  const parsed = extractJson(res.content);
  if (!parsed || typeof parsed !== 'object') {
    return {
      ok: false,
      edits: [],
      rationale: '',
      modelConfidence: 'low',
      error: `could not parse a JSON object from the response: ${res.content.slice(0, 300)}`,
      ...(res.usage ? { usage: res.usage } : {}),
    };
  }

  const obj = parsed as Record<string, unknown>;
  const rawEdits = Array.isArray(obj['edits']) ? obj['edits'] : [];
  const edits = rawEdits.filter(isTextEdit).map((e) => ({
    file: e.file,
    find: e.find,
    replace: e.replace,
    reason: typeof e.reason === 'string' ? e.reason : 'agent-proposed edit',
  }));

  const confidence = obj['confidence'];
  return {
    ok: true,
    edits,
    rationale: typeof obj['rationale'] === 'string' ? obj['rationale'] : '',
    modelConfidence:
      confidence === 'high' || confidence === 'medium' || confidence === 'low'
        ? confidence
        : 'medium',
    ...(res.usage ? { usage: res.usage } : {}),
  };
}

/**
 * Symbols in the target version that share a container with the changed symbol.
 *
 * Giving the model the real candidate list is the cheapest available defence
 * against invented APIs — it can still hallucinate, but it has no excuse to.
 */
export function nearbySymbols(
  changedPath: string,
  toSymbols: Record<string, { path: string; deprecated: boolean }>,
): string[] {
  const dot = changedPath.lastIndexOf('.');
  const parent = dot === -1 ? '' : changedPath.slice(0, dot);
  const leaf = (dot === -1 ? changedPath : changedPath.slice(dot + 1)).toLowerCase();

  const leafOf = (p: string): string => {
    const i = p.lastIndexOf('.');
    return (i === -1 ? p : p.slice(i + 1)).toLowerCase();
  };

  // Same-container siblings, *plus* any symbol elsewhere carrying the same leaf
  // name. Restricting to siblings makes a relocated helper — `record` becoming
  // `core.record` — impossible to offer, because the filter runs before the
  // ranking below ever sees it. The model is told to use nothing outside this
  // list, so a migration that moves a symbol between containers could not be
  // expressed at all.
  const out: string[] = [];
  for (const s of Object.values(toSymbols)) {
    if (s.deprecated) continue;
    const sDot = s.path.lastIndexOf('.');
    const sParent = sDot === -1 ? '' : s.path.slice(0, sDot);
    if (sParent === parent || leafOf(s.path) === leaf) out.push(s.path);
  }

  // Rank by name similarity to the symbol that broke, not alphabetically.
  //
  // The prompt can only carry a slice of this list, and the model is instructed
  // to use nothing outside it. Sorting alphabetically buried zod 4's
  // `partialRecord` — the exact replacement for a broken `record` call — at
  // position ~200 of 264, past the cutoff. The model then could not name the one
  // symbol that would have fixed the build, and spent three attempts failing.
  const score = (candidatePath: string): number => {
    const cDot = candidatePath.lastIndexOf('.');
    const cParent = cDot === -1 ? '' : candidatePath.slice(0, cDot);
    const name = leafOf(candidatePath);
    const sibling = cParent === parent;
    if (name === leaf) return sibling ? 0 : 1; // same name, here or relocated
    if (name.includes(leaf)) return 2; // record -> partialRecord, looseRecord
    if (leaf.includes(name)) return 3;
    return 4;
  };

  return out.sort((a, b) => {
    const diff = score(a) - score(b);
    return diff !== 0 ? diff : a.localeCompare(b);
  });
}

// ---------------------------------------------------------------------------
// Evidence: deciding which proposed edits the upgrade actually asked for.
// ---------------------------------------------------------------------------

/** A compiler or test diagnostic, reduced to the location it points at. */
export interface Diagnostic {
  file: string;
  line: number;
}

/** `src/schema.ts(28,15): error TS2554: ...` — tsc's own format. */
const TSC_DIAGNOSTIC = /^\s*(\S+?)\((\d+),(\d+)\):\s*error\b/gm;
/** `src/schema.ts:28:15: error ...` — most other tools. */
const COLON_DIAGNOSTIC = /^\s*(\S+?):(\d+):(\d+):\s*error\b/gm;

/**
 * Where the failure points, not how much of it there is.
 *
 * `failureSize` in fix.ts already counts errors to drive keep-or-rollback. This
 * is the other half: a count cannot say whether a proposed edit lands somewhere
 * the compiler actually complained about, and that is the only question the
 * evidence gate below can be answered with.
 */
export function parseDiagnostics(output: string): Diagnostic[] {
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  for (const pattern of [TSC_DIAGNOSTIC, COLON_DIAGNOSTIC]) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(output)) !== null) {
      const [, file, rawLine, rawColumn] = m;
      const line = Number(rawLine);
      if (!file || !Number.isFinite(line)) continue;
      const key = `${file}:${line}:${rawColumn}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ file, line });
    }
  }
  return out;
}

export type EditEvidence = 'evidenced' | 'unrequested';

export interface EditClassification {
  edit: TextEdit;
  evidence: EditEvidence;
  reason: string;
}

/** Tolerate the same file being named relative to different roots. */
function sameFile(a: string, b: string): boolean {
  const an = a.replace(/\\/g, '/');
  const bn = b.replace(/\\/g, '/');
  return an === bn || an.endsWith(`/${bn}`) || bn.endsWith(`/${an}`);
}

/** 1-indexed line span of `find` inside `content`, or null when absent. */
function spanOf(content: string, find: string): { start: number; end: number } | null {
  const index = content.indexOf(find);
  if (index === -1) return null;
  const start = content.slice(0, index).split('\n').length;
  return { start, end: start + find.split('\n').length - 1 };
}

/**
 * Split proposed edits into those the current failure supports and those it does not.
 *
 * The failure mode this exists for is measured, not hypothetical: asked to fix a
 * `z.record` arity break, models also rewrote `.uuid()` and `.email()` at the
 * call sites of *deprecation* findings — extra edits that compile, pass every
 * test, and silently change runtime error messages nobody asked to touch. No
 * later stage can catch that, because the edits are correct; they are merely
 * unnecessary. Rule 3 of the system prompt asks for restraint and the measured
 * model comparison shows asking is not enough.
 *
 * The discriminator is evidence Emend already holds. A diagnostic pointing into
 * an edit's own span is positive evidence the upgrade requires it. A known call
 * site with no diagnostic on it is positive evidence the compiler is content
 * with that line. Anything else — an import rewrite, a Dockerfile the failing
 * test reads — has no evidence either way and is left alone, because dropping it
 * would lose real repairs.
 *
 * This does not weaken rule 7 (fix errors the change list does not explain): the
 * authority here is the diagnostic, not the list, so an unexplained error still
 * evidences its own fix.
 */
export function classifyEdits(
  edits: TextEdit[],
  changes: Array<{ change: SurfaceChange; sites: CallSite[] }>,
  failureOutput: string,
  sources: Map<string, string>,
  /**
   * Paths of deprecation findings the migration has not resolved yet, measured
   * from the files as they currently stand.
   *
   * A deprecated call never produces a compiler error, so a diagnostic-only rule
   * cannot tell the edit that *resolves* the finding from the churn that merely
   * disturbs it. Whether the symbol is still there can.
   */
  unresolvedDeprecations: ReadonlySet<string> = new Set(),
): EditClassification[] {
  const diagnostics = parseDiagnostics(failureOutput);

  // A failing test suite reports no `file(line,col): error` anywhere, so there
  // is no positive evidence for any location. Without that, an edit merely
  // *away* from a call site would count as evidenced by absence of information —
  // and one such edit is enough to start withholding real ones. The gate has to
  // abstain rather than invent a verdict from silence.
  if (diagnostics.length === 0) {
    return edits.map((edit) => ({
      edit,
      evidence: 'evidenced' as const,
      reason: 'the failure reports no diagnostic locations to judge against',
    }));
  }

  return edits.map((edit): EditClassification => {
    const content = sources.get(edit.file);
    const span = content ? spanOf(content, edit.find) : null;
    if (!span) {
      // Unlocatable here means the applicator will reject it anyway; let it, so
      // one place decides and one reason is reported.
      return { edit, evidence: 'evidenced', reason: 'could not be located to judge' };
    }

    const pointedAt = diagnostics.some(
      (d) => sameFile(d.file, edit.file) && d.line >= span.start && d.line <= span.end,
    );
    if (pointedAt) {
      return {
        edit,
        evidence: 'evidenced',
        reason: `a diagnostic points into ${edit.file}:${span.start}`,
      };
    }

    // Which change owns this line, not merely whether some change does: a
    // deprecation that is still outstanding evidences its own repair, and only
    // the owning change can say whether that is the case.
    const owner = changes.find((c) =>
      c.sites.some(
        (s) => sameFile(s.file, edit.file) && s.line >= span.start && s.line <= span.end,
      ),
    );
    if (owner) {
      if (unresolvedDeprecations.has(owner.change.path)) {
        return {
          edit,
          evidence: 'evidenced',
          reason: `${owner.change.path} is deprecated and still present here`,
        };
      }
      return {
        edit,
        evidence: 'unrequested',
        reason: `${edit.file} line ${span.start} is a known call site with nothing outstanding on it`,
      };
    }

    return { edit, evidence: 'evidenced', reason: 'no call site and no diagnostic here' };
  });
}

/** A changed region of a file, as a unified diff describes it. */
export interface DiffHunk {
  file: string;
  /** 1-indexed, counted in the new file — the state on disk. */
  start: number;
  end: number;
}

export interface HunkClassification {
  hunk: DiffHunk;
  evidence: EditEvidence;
  reason: string;
}

/**
 * The changed regions of a unified diff.
 *
 * A harness with filesystem access cannot be gated by inspecting proposed
 * `find`/`replace` pairs, because it never proposes any — it writes. The only
 * artefact it leaves behind is the diff, so the gate reads that instead. This is
 * the precondition the design spec puts on adopting one: the fail-closed
 * property is what an agent with write access costs, and it is only recoverable
 * if the gate can judge a diff.
 *
 * Line numbers come from the `+` side of the `@@` header, because that is the
 * state on disk and the state the compiler reports against.
 */
export function parseDiffHunks(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let file = '';
  for (const line of diff.split('\n')) {
    const target = line.match(/^\+\+\+ b\/(.+)$/);
    if (target?.[1]) {
      file = target[1];
      continue;
    }
    const header = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!header || !file) continue;
    const start = Number(header[1]);
    const span = header[2] === undefined ? 1 : Number(header[2]);
    if (!Number.isFinite(start)) continue;
    hunks.push({ file, start, end: start + Math.max(0, span - 1) });
  }
  return hunks;
}

/**
 * Judge changed regions by the rule `classifyEdits` applies to proposed edits.
 *
 * Same question, same evidence, different shape — which is what lets the gate
 * survive a harness that writes files instead of proposing text. A diagnostic
 * inside a hunk says the upgrade required it; a known call site inside it with
 * nothing outstanding says the compiler is content with that line; anything else
 * has no evidence either way and is left alone.
 */
export function classifyHunks(
  hunks: DiffHunk[],
  changes: Array<{ change: SurfaceChange; sites: CallSite[] }>,
  failureOutput: string,
  unresolvedDeprecations: ReadonlySet<string> = new Set(),
): HunkClassification[] {
  const diagnostics = parseDiagnostics(failureOutput);

  // Judging from silence is how a gate starts withholding real repairs.
  if (diagnostics.length === 0) {
    return hunks.map((hunk) => ({
      hunk,
      evidence: 'evidenced' as const,
      reason: 'the failure reports no diagnostic locations to judge against',
    }));
  }

  return hunks.map((hunk): HunkClassification => {
    const pointedAt = diagnostics.some(
      (d) => sameFile(d.file, hunk.file) && d.line >= hunk.start && d.line <= hunk.end,
    );
    if (pointedAt) {
      return {
        hunk,
        evidence: 'evidenced',
        reason: `a diagnostic points into ${hunk.file}:${hunk.start}`,
      };
    }

    const owner = changes.find((c) =>
      c.sites.some((s) => sameFile(s.file, hunk.file) && s.line >= hunk.start && s.line <= hunk.end),
    );
    if (owner) {
      if (unresolvedDeprecations.has(owner.change.path)) {
        return {
          hunk,
          evidence: 'evidenced',
          reason: `${owner.change.path} is deprecated and still present here`,
        };
      }
      return {
        hunk,
        evidence: 'unrequested',
        reason: `${hunk.file}:${hunk.start} covers a call site with nothing outstanding on it`,
      };
    }

    return { hunk, evidence: 'evidenced', reason: 'no call site and no diagnostic here' };
  });
}

/**
 * Keep the edits the failure supports, dropping the rest — unless none are
 * supported, in which case the model's proposal is all there is and verification
 * remains the judge. Silently dropping everything would turn a possible repair
 * into a guaranteed no-op.
 */
export function selectEvidencedEdits(classified: EditClassification[]): {
  keep: TextEdit[];
  dropped: EditClassification[];
} {
  const evidenced = classified.filter((c) => c.evidence === 'evidenced');
  if (evidenced.length === 0) return { keep: classified.map((c) => c.edit), dropped: [] };
  return {
    keep: evidenced.map((c) => c.edit),
    dropped: classified.filter((c) => c.evidence === 'unrequested'),
  };
}
