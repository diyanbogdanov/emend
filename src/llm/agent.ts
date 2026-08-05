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
}

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
8. Never weaken types to silence an error. Do not introduce any, "as any", "as unknown as", @ts-ignore or @ts-expect-error. When a parameter type has widened, name the new constraint using a type the package exports — the error text usually names it, and it is usually in the available-symbols list, sometimes under a different export name. Prefer (value: TooltipValueType | undefined) => Number(value ?? 0).toFixed(1) over (value: any) => (value ?? 0).toFixed(1). If no exported type names it, omit the annotation and let it be inferred from context. All three compile; only the first two keep the checking the project paid for, and the first says why the coercion is there.

Respond with exactly this shape:
{
  "edits": [{"file": "src/x.ts", "find": "<exact unique substring>", "replace": "<replacement>", "reason": "<short why>"}],
  "rationale": "<one or two sentences on the overall change>",
  "confidence": "high" | "medium" | "low"
}`;

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
  const messages: ChatMessage[] = [
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
