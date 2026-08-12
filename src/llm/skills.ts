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
 * How a job that writes files reports what it did.
 *
 * Replaces the JSON edit-set contract the four tasks shared until §11. That
 * contract existed because a proposer had to hand its work to a parser; an agent
 * working in the checkout has no parser between it and the disk, and telling it
 * to emit JSON is telling it to describe a change instead of making one.
 *
 * The three things the old contract carried are kept, because each was load
 * bearing and none of them was about JSON: a rationale, a confidence, and the
 * statement that changing nothing is a valid answer. The last one matters most —
 * a pass that invents work to look busy is worse than one that declines, and
 * without saying so the model treats an empty result as failure.
 *
 * Shared by all four tasks. `LINT_TASK` used to state the same contract inline
 * in its own words, which meant two statements of one requirement kept in step
 * by hand; there is no parser left for them to disagree about, so there is one.
 */
export const WRITE_AND_REPORT: Skill = {
  name: 'write-and-report',
  text: `Edit the files in the working directory directly. Do not print a patch, a JSON object, or a list of changes you would make — what is on disk when you finish is the result, and anything you only describe is lost.

When you are done, finish with a short report:
- what you changed and why, in one or two sentences
- anything you could not fix, and what stopped you
- how confident you are that the change is correct: high, medium or low

Changing nothing is a valid outcome. If you cannot make a correct change, leave the files as they are and say why. An empty result is far better than a wrong one.`,
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
