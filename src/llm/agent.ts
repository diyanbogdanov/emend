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
  /** Verification output from the previous failed attempt, if any. */
  previousAttempt?: {
    edits: TextEdit[];
    errors: string;
  };
  /**
   * Set when this is a tightening repair rather than a migration.
   *
   * These two tasks want opposite things, and sharing a prompt made the model
   * fail at both. Migration says "change only what the API requires" and "prefer
   * naming the type"; tightening needs the body rewritten and the annotation
   * left off. Worse, routing tightening through `previousAttempt` appended
   * "the source shown above is the ORIGINAL, unmodified file" — false at that
   * point, because the annotations are already stripped on disk. A model that
   * believed it would copy `find` strings that no longer exist, every edit would
   * be rejected as absent, and the step would report nothing at all.
   */
  tightening?: { errors: string };
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

const SYSTEM_PROMPT = `You are a precise TypeScript migration engine.

You are given the API changes in a dependency upgrade, the exact lines in a codebase that use them, and the symbols available in the new version. Produce the minimal source edits that make the code correct under the new version.

Rules you must follow:
1. Output ONLY a JSON object. No prose, no markdown fences.
2. Each edit's "find" MUST be an exact substring copied character-for-character from the provided source, and MUST be unique within that file. Include surrounding context to make it unique.
3. Change only what the API changes require. Do not reformat, rename variables, add comments, or refactor.
4. Only use symbols that appear in the provided list of available symbols. Never invent an API.
5. If you cannot determine a correct edit, return an empty "edits" array and explain why in "rationale". An empty result is far better than a wrong one.
6. When compiler output from a failed attempt is provided, it is the authoritative statement of what is still broken. Fix the errors it reports. Do not edit call sites it does not complain about, however plausible the change looks.
7. The list of API changes is derived from a type-declaration diff and can be incomplete. If the compiler reports an error the list does not explain, fix it anyway using the error's own description of the expected type. Do not decline solely because an error is absent from the list.
8. Prefer the strongest type that compiles, in this order. First, name the constraint with a type the package exports — the error text usually names it and it is usually in the available-symbols list, sometimes under a different export name; prefer (value: TooltipValueType | undefined) => Number(value ?? 0).toFixed(1). Second, omit the annotation and let it be inferred from context. Only if neither compiles, use any or a cast, and say so in that edit's "reason". Never use @ts-ignore or @ts-expect-error. Getting to green matters more than getting there elegantly, but try the stronger forms first.

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
7. Fix each error by handling the real inferred type in the function body. Choose the form by what the compiler says the type actually is:
   a. The type is a union with more than one non-undefined member (for example \`ValueType\`, which is \`number | string | ReadonlyArray<number | string>\`) — you MUST narrow with a runtime check, and every branch must still produce a sensible result:
      \`typeof value === 'number' ? value.toFixed(1) : String(value ?? '')\`
      The branch that is NOT the numeric one must pass its value through, typically with \`String(...)\`. Do not funnel it back through \`Number(...)\`: \`Number('n/a')\` is \`NaN\`, so a label that was meant to read "n/a" reaches the user as "NaN". A \`typeof\` check whose else branch is \`Number(value)\` is the same silent bug wearing a disguise.
   b. Only \`undefined\` is the problem and the remaining type is already what you need — guard it:
      \`value?.toFixed(1) ?? ''\`
   Blanket coercion such as \`Number(value ?? 0)\` is NOT acceptable in case (a). It compiles, so nothing will object to it, but it renders a real string value as "0" — a silent behaviour change that no test catches and no reviewer sees. Narrowing keeps that case rendering correctly. Only reach for a coercion when the union has exactly one non-undefined member.
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
  return lines.join('\n');
}

function describeSites(sites: CallSite[]): string {
  return sites
    .map((s) => `- ${s.file}:${s.line}:${s.column}  ${s.text}`)
    .join('\n');
}

function buildUserPrompt(ctx: AgentContext): string {
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

  if (ctx.previousAttempt) {
    parts.push('# Your previous attempt FAILED verification');
    parts.push('These edits were applied:');
    parts.push('```json');
    parts.push(JSON.stringify(ctx.previousAttempt.edits, null, 2));
    parts.push('```');
    parts.push('The compiler/test output was:');
    parts.push('```');
        // The compiler output is the most reliable thing in this prompt: it states
    // exactly what is still wrong, in a form that cannot be misremembered.
    // Truncating it hides failures the model is then blamed for not fixing.
    parts.push(ctx.previousAttempt.errors.slice(0, 40_000));
    parts.push('```');
    parts.push(
      'Correct the edits. Note the source shown above is the ORIGINAL, unmodified file — your new edits apply to that, not to your previous attempt.',
    );
    parts.push('');
  }

  parts.push('Produce the JSON now.');
  return parts.join('\n');
}

/**
 * The tightening prompt: compiler output and the current sources, nothing else.
 *
 * The API diff and the candidate symbol list are deliberately omitted. Both exist
 * to help the model choose a replacement symbol, and choosing a symbol is not
 * this task — every remaining error is about a value's real type, which the
 * compiler has already named. Sending them costs context and invites the model
 * to "fix" call sites the compiler is happy with.
 */
export function buildTighteningPrompt(ctx: AgentContext, errors: string): string {
  const { finding } = ctx;
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

export async function proposeEdits(
  config: LlmConfig,
  ctx: AgentContext,
): Promise<AgentProposal> {
  const { tightening } = ctx;
  const messages: ChatMessage[] = tightening
    ? [
        { role: 'system', content: TIGHTENING_SYSTEM_PROMPT },
        { role: 'user', content: buildTighteningPrompt(ctx, tightening.errors) },
      ]
    : [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(ctx) },
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

  const out: string[] = [];
  for (const s of Object.values(toSymbols)) {
    if (s.deprecated) continue;
    const sDot = s.path.lastIndexOf('.');
    const sParent = sDot === -1 ? '' : s.path.slice(0, sDot);
    if (sParent === parent) out.push(s.path);
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
    const name = (cDot === -1 ? candidatePath : candidatePath.slice(cDot + 1)).toLowerCase();
    if (name === leaf) return 0;
    if (name.includes(leaf)) return 1; // record -> partialRecord, looseRecord
    if (leaf.includes(name)) return 2;
    return 3;
  };

  return out.sort((a, b) => {
    const diff = score(a) - score(b);
    return diff !== 0 ? diff : a.localeCompare(b);
  });
}
