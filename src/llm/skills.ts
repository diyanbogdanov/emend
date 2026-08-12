/**
 * Instruction fragments that more than one task says, named once.
 *
 * A skill exists because of what happened when one did not. The narrowing rule
 * below lived in the tightening prompt alone; a migration that had to narrow a
 * union therefore wrote \`Number(value)\` unguided, and the recharts tooltip
 * rendered \`$NaN\` in a build that typechecked and passed every test. The rule
 * was not wrong and nobody had disagreed with it — it simply was not in the other
 * prompt, and prose sitting in one file cannot be seen to be missing from another.
 *
 * So the unit here is a referenced object, not a copied paragraph. A task lists
 * the skills it includes, and one it leaves out is a decision that reads as one:
 * \`REVIEW_TASK.rules.includes(NARROWING)\` is a question with an answer, where
 * "does the review prompt mention narrowing" is a question about 4KB of prose.
 *
 * What is deliberately NOT here is anything said once. A single-use fragment
 * given a name is sharing that is not happening, and it costs every reader the
 * hop to find that out.
 */

/** A named instruction fragment. `name` is for logs; `text` is used verbatim. */
export interface Skill {
  name: string;
  text: string;
}

/**
 * The output contract the repair tasks depend on.
 *
 * \`propose\` parses one shape and one shape only, so a task that drifted here
 * would produce edits the parser silently drops — downstream, a model that
 * answered perfectly and a model that was unreachable look the same.
 *
 * \`LINT_TASK\` deliberately does not use this. It states the same contract
 * inline and more compactly, so there are two statements of one parser's
 * requirements to keep in step by hand. Unifying them would change wording a
 * model has been measured against, which is an experiment for its own commit.
 */
export const RESPONSE_SHAPE: Skill = {
  name: 'response-shape',
  text: `Respond with exactly this shape:
{
  "edits": [{"file": "src/x.ts", "find": "<exact unique substring>", "replace": "<replacement>", "reason": "<short why>"}],
  "rationale": "<one or two sentences on the overall change>",
  "confidence": "high" | "medium" | "low"
}`,
};

/**
 * How to handle a value whose type is a union, wherever one can turn up.
 *
 * Neither clause is decoration; each was bought with a measured wrong answer.
 * Given only a soft "prefer narrowing", the model returned
 * \`Number(value ?? 0).toFixed(1)\` — compiles, and renders a real string as
 * "0". Naming that unacceptable produced a \`typeof\` guard with
 * \`Number(value)\` in the else branch, which renders "NaN" instead. The two
 * sentences at the end of the text closed those in turn.
 */
export const NARROWING: Skill = {
  name: 'narrowing',
  text: `Handle the real type. Choose the form by what the compiler says the type actually is:
   a. The type is a union with more than one non-undefined member (for example \`ValueType\`, which is \`number | string | ReadonlyArray<number | string>\`) — you MUST narrow with a runtime check, and every branch must still produce a sensible result:
      \`typeof value === 'number' ? value.toFixed(1) : String(value ?? '')\`
      The branch that is NOT the numeric one must pass its value through, typically with \`String(...)\`. Do not funnel it back through \`Number(...)\`: \`Number('n/a')\` is \`NaN\`, so a label that was meant to read "n/a" reaches the user as "NaN". A \`typeof\` check whose else branch is \`Number(value)\` is the same silent bug wearing a disguise.
   b. Only \`undefined\` is the problem and the remaining type is already what you need — guard it:
      \`value?.toFixed(1) ?? ''\`
   Blanket coercion such as \`Number(value ?? 0)\` or \`Number(value)\` is NOT acceptable in case (a). It compiles, so nothing will object to it, but it renders a real string as "0" and a missing value as "NaN" — a silent behaviour change no test catches and no reviewer sees. Only reach for a coercion when the union has exactly one non-undefined member.`,
};
