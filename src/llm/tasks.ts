/**
 * The four jobs, as data.
 *
 * Each is one thing the model is asked to do: which skills it includes, what it
 * says beyond them, and how it renders its context. `harness.ts` composes them
 * and calls `ask`; nothing here knows a model exists.
 *
 * They belong in one file because **they contradict each other on purpose**, and
 * a contradiction is only checkable where both sides are visible. Migration
 * forbids touching a function body; tightening requires it. Migration prefers
 * naming a type; tightening forbids naming one. Review exists partly to undo
 * what tightening was told to leave. Handed both sets of rules at once a model
 * satisfies the wrong one, which is why these are four tasks and not one task
 * with flags.
 *
 * Rules are a list rather than a numbered block so that the numbering is
 * generated: a rule inserted at position 3 of a prompt with ten of them used to
 * mean renumbering seven by hand, in prose that also refers to rule numbers.
 *
 * These are the most-edited lines in the repository and the least covered by
 * tests, because what a prompt is worth is measured by running it. Changing one
 * is an experiment, not a refactor — `test/prompts.golden.test.ts` holds every
 * word of them against the wording that was measured.
 */

import { renderImpact, type SymbolImpact } from '../impact.ts';
import type { CallSite, Finding, SurfaceChange } from '../types.ts';
import { NARROWING, WRITE_AND_REPORT, type Skill } from './skills.ts';
import { loadSkill, REVIEW_SKILL_DEFAULT, COMPLETENESS_SKILL } from './skillfiles.ts';

/**
 * One job the model can be given.
 *
 * A rule is either literal text or a `Skill`. That the two are the same list is
 * the point: a shared instruction is a reference, an unshared one is a string,
 * and which is which is visible at the call site instead of being a fact about
 * four files. `rules.includes(NARROWING)` answers what reading 4KB of prose
 * used to.
 */
export interface Task<Ctx> {
  /** Identifies the job in logs and in the eval corpus. */
  name: string;
  /** Who the model is and what it has been handed. Everything before the rules. */
  preamble: string;
  /** The line introducing the rules. Two of the four word it differently. */
  rulesHeading: string;
  /** Ordered. Numbering is generated, so inserting one renumbers nothing by hand. */
  rules: ReadonlyArray<string | Skill>;
  /** Everything after the rules, each entry separated by a blank line. */
  closing: ReadonlyArray<string | Skill>;
  /** The context, as the user prompt. The only part that varies per run. */
  render(ctx: Ctx): string;
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
   * What else in the repository depends on the symbols in `sources`.
   *
   * Every other section here describes the *dependency's* API — where the break
   * arrived. This is the reach of the model's own edit, which nothing described
   * before: change a helper's signature to satisfy one error and its other
   * callers break, and the only way that was learned was the next red build.
   *
   * Optional because it is a best effort. A language with no analyzer, or a
   * repository whose program will not build, yields nothing — and nothing must
   * read as "not looked at", never as "nothing depends on this".
   */
  impact?: SymbolImpact[];
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
 * Carry a codebase onto the new version of a dependency.
 *
 * The escalation's job: `fixPackage` hands this to `runTask` when deterministic
 * work left the build red. It sat dormant for a stretch — the loop that drove
 * it was deleted on the argument that repair belongs to an agent driving the
 * MCP tools, and the cost was recorded: `emend fix --agent` stopped repairing a
 * breaking upgrade from the CLI, FIXED to NOT FIXED on the axios bait repo. The
 * harness becoming the one writer gave it a caller again.
 *
 * Kept through the dormancy because it is the grounded strategy both papers
 * argue for — Byam's 27% improves markedly when the model is given the API
 * diff, the failing lines and compiler feedback, which is exactly what
 * `AgentContext` carries.
 */
export const MIGRATION_TASK: Task<AgentContext> = {
  name: 'migration',
  preamble: `You are a precise TypeScript migration engine.

You are given the API changes in a dependency upgrade, the exact lines in a codebase that use them, and the symbols available in the new version. Produce the minimal source edits that make the code correct under the new version.`,
  rulesHeading: `Rules you must follow:`,
  rules: [
    `Change only what the API changes require. Do not reformat, rename variables, add comments, or refactor.
   The deprecations listed above ARE required. A deprecated symbol never produces a compiler error, so nothing downstream will object if you leave it — and a migration that reports "X is deprecated" and ships with X still in the code has not done what it said. Replace each one with its current equivalent from the available-symbols list. If a deprecation genuinely has no replacement there, leave it and say so in "rationale".`,
    `Only use symbols that appear in the provided list of available symbols. Never invent an API.`,
    `If you cannot determine a correct change, leave the code as it is and explain why. An empty result is far better than a wrong one.`,
    `When compiler output from a failed attempt is provided, it is the authoritative statement of what is still broken. Fix the errors it reports. Do not edit call sites it does not complain about, however plausible the change looks.`,
    `The list of API changes is derived from a type-declaration diff and can be incomplete. If the compiler reports an error the list does not explain, fix it anyway using the error's own description of the expected type. Do not decline solely because an error is absent from the list.`,
    `Prefer the strongest type that compiles, in this order. First, name the constraint with a type the package exports — the error text usually names it and it is usually in the available-symbols list, sometimes under a different export name; prefer (value: TooltipValueType | undefined) => Number(value ?? 0).toFixed(1). Second, omit the annotation and let it be inferred from context. Only if neither compiles, use any or a cast, and say so in that edit's "reason". Never use @ts-ignore or @ts-expect-error. Getting to green matters more than getting there elegantly, but try the stronger forms first.`,
    NARROWING,
    `A "Code that depends on your edit" section, when present, lists symbols in these files that other files call, and the places that call them. Changing such a symbol's shape — its parameters, its return type, its name — breaks every place listed there. Prefer a fix that leaves those signatures alone; adapt inside the body instead. If one genuinely must change, the edit set is not finished until every listed site changes with it. A symbol absent from a section that is present had no callers found outside its own file — reflection and dynamic property access are invisible to that analysis, so treat it as probably free to reshape, not certainly. If the section is absent entirely, nothing was measured at all.`,
  ],
  closing: [
    WRITE_AND_REPORT,
  ],
  render: renderMigration,
};

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
 *
 * Composed from two skills rather than a fixed block of prose.
 *
 * **Completeness under quality, in that order.** They answer different
 * questions and only one of them is a matter of taste. `migration-completeness`
 * asks whether the migration did what it reported — the deprecated call gone,
 * the comment it falsified corrected — and is not swappable, because a review
 * that skipped it would judge the elegance of a migration that never finished.
 * The quality skill on top is a house opinion about what good code looks like,
 * and hard-coding one would make disagreeing with Emend a fork.
 *
 * Rule order is the precedence. `systemPrompt` numbers them in sequence, and the
 * completeness rules come first because a structural regression outranks a
 * simplification but an unfinished migration outranks both.
 */
export function reviewTask(qualitySkill: string = REVIEW_SKILL_DEFAULT): Task<ReviewContext> {
  return {
    name: 'review',
    preamble: `You are a demanding code reviewer with commit rights, reviewing a dependency migration that already compiles and passes its tests.

Passing is the floor, not the goal. Decide whether this diff leaves the codebase better or merely green, and fix it where it does not. You have edit rights: make the changes, do not merely describe them.`,
    rulesHeading: `Rules you must follow:`,
    rules: [
      `Two standards apply, and they are stated in full below. MIGRATION COMPLETENESS says when the migration is finished; CODE QUALITY says whether the result is good. Where they conflict, finishing wins — a beautifully restructured migration that still calls the deprecated API has not done its job.`,
      `You may edit any file the migration touched. Work outside those files is reverted before anything is verified, so spending your single attempt there spends it on nothing — say those concerns in "rationale" instead, where they reach a human.`,
    ],
    closing: [
      // Below the numbered rules, not among them: each skill carries its own
      // headings and its own numbering, and nesting that inside Emend's would
      // put two "rule 1"s in one prompt — the exact collision the generated
      // numbering exists to prevent.
      { name: 'completeness', text: `--- STANDARD 1: MIGRATION COMPLETENESS ---\n\n${loadSkill(COMPLETENESS_SKILL).text}` },
      { name: 'quality', text: `--- STANDARD 2: CODE QUALITY ---\n\n${loadSkill(qualitySkill).text}` },
      WRITE_AND_REPORT,
    ],
    render: renderReview,
  };
}

/** The review as configured by default. */
export const REVIEW_TASK: Task<ReviewContext> = reviewTask();

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
export const TIGHTENING_TASK: Task<TighteningContext> = {
  name: 'tightening',
  preamble: `You are a precise TypeScript engine performing a follow-up cleanup task.

A dependency migration has already been completed and verified. The \`: any\` annotations on its function parameters were then removed, so those parameters now infer their real types from context. That exposed the errors you are given: code that compiled only because \`any\` had switched checking off.

Your job is to make that code correct at the point of use, leaving the parameters inferred.`,
  rulesHeading: `Rules you must follow:`,
  rules: [
    `The source files you are shown are the CURRENT state, with the annotations ALREADY REMOVED. Read the files on disk rather than working from what the code looked like before — the annotations you may remember are gone.`,
    `NEVER re-add a parameter type annotation — not \`: any\`, and not a named type either. The parameter must stay inferred. Re-adding one undoes the entire point of this task.`,
    `NEVER use a type assertion (\`as X\`), \`@ts-ignore\`, or \`@ts-expect-error\`.`,
    `Editing the function BODY is exactly what this task requires. It is not a refactor and it is not out of scope. Change as much of the body as the fix needs, and nothing beyond that.`,
    NARROWING,
    `The compiler output is the authoritative statement of what is broken. Fix what it reports, and do not edit code it does not complain about.`,
    `If an error cannot be fixed without breaking one of these rules, leave it alone. A partial repair is fine and expected — a file still failing simply keeps its original annotations.`,
  ],
  closing: [
    WRITE_AND_REPORT,
  ],
  render: renderTightening,
};

function renderMigration(ctx: AgentContext): string {
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

  const impact = renderImpact(ctx.impact ?? []);
  if (impact) {
    parts.push('# Code that depends on your edit');
    parts.push(impact);
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

  parts.push('Make the changes now.');
  return parts.join('\n');
}

/**
 * The tightening prompt: compiler output and the current sources, nothing else.
 *
 * Sending the API diff and the candidate symbol list as well would cost context
 * and invite the model to "fix" call sites the compiler is happy with, so
 * `TighteningContext` does not carry them at all.
 */
function renderTightening(ctx: TighteningContext): string {
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

  parts.push('Make the changes now. Fix the bodies; leave the parameters inferred.');
  return parts.join('\n');
}

/**
 * The review prompt: what the migration did, what it left undone, the files.
 *
 * Unlike the tightening prompt this carries the candidate symbols, because
 * finishing a deprecation means naming what replaced the symbol — and unlike
 * either of the others it carries the diff, because "is this worth merging"
 * cannot be answered from the files alone.
 */
function renderReview(ctx: ReviewContext): string {
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

  parts.push('Make the changes now. Changing nothing is a valid answer.');
  return parts.join('\n');
}

/**
 * The prompt for repairing what an external linter objects to.
 *
 * Deliberately not the migration prompt. There is no API contract here, no
 * symbol table, and no compiler — the whole of the evidence is a rule code, a
 * line, and a sentence from the tool, and the model's job is to satisfy that
 * sentence without becoming an opinion about the file.
 */
export const LINT_TASK: Task<LintFixContext> = {
  name: 'lint',
  preamble: `You are repairing exactly the issues an external linter reported in a Dockerfile or shell script.

You will be given each finding as a rule code, a file, a line, and the linter's own message, plus the full text of each file.`,
  rulesHeading: `Rules:`,
  rules: [
    `Fix only the lines the linter flagged. Nothing else in the file is yours to change — not formatting, not ordering, not a nearby thing you would have written differently.`,
    `Satisfy what the message actually asks for. Do not silence a rule by deleting the line it objects to, and do not add a suppression comment.`,
    `If a finding cannot be fixed without knowing something the file does not tell you — a version to pin, an intent behind a command — leave it and say so in your rationale.`,
    `Preserve behaviour. A Dockerfile that no longer installs what it installed, or a script that no longer does what it did, is a worse outcome than the lint warning.`,
  ],
  closing: [
    WRITE_AND_REPORT,
  ],
  render: renderLint,
};

export interface LintFixContext {
  findings: Array<{ file: string; line: number; code: string; message: string }>;
  sources: Map<string, string>;
}

function renderLint(ctx: LintFixContext): string {
  const lines: string[] = ['Findings to repair:', ''];
  for (const f of ctx.findings) {
    lines.push(`${f.file}:${f.line}:1: ${f.code} — ${f.message}`);
  }
  lines.push('');
  for (const [file, source] of ctx.sources) {
    lines.push(`--- ${file} ---`);
    lines.push(source.slice(0, 8000));
    lines.push('');
  }
  return lines.join('\n');
}

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
