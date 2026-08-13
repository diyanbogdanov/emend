---
name: thermo-nuclear-code-quality-review
description: An extremely strict maintainability review for abstraction quality, giant files, and spaghetti-condition growth. Emend's default review skill.
source: https://github.com/cursor/plugins/blob/main/cursor-team-kit/skills/thermo-nuclear-code-quality-review/SKILL.md
---

# Thermo-Nuclear Code Quality Review

Use this skill for an unusually strict review focused on implementation quality,
maintainability, abstraction quality, and codebase health.

Above all, be **ambitious** about code structure. Do not merely identify local
cleanup opportunities. Actively search for "code judo" moves: restructurings that
preserve behavior while making the implementation dramatically simpler, smaller,
more direct, and more elegant.

## Core Prompt

> Perform a deep code quality audit of the current branch's changes.
> Rethink how to structure / implement the changes to meaningfully improve code
> quality without impacting behavior.
> Work to improve abstractions, modularity, reduce spaghetti code, improve
> succinctness and legibility.
> Be ambitious: if there is a clear path to improving the implementation that
> involves restructuring, go for it.
> Be extremely thorough and rigorous. Measure twice, cut once.

## Non-Negotiable Additional Standards

0. **Be ambitious about structural simplification.** Do not stop at "this could
   be a bit cleaner." Look for opportunities to reframe the change so that whole
   branches, helpers, modes, conditionals or layers disappear entirely. Prefer
   the solution that makes the code feel inevitable in hindsight. If you see a
   path to delete complexity rather than rearrange it, push hard for that path.

1. **Do not let a change push a file from under 1k lines to over 1k lines
   without a very strong reason.** Treat it as a strong code-quality smell.
   Prefer extracting helpers, subcomponents or modules. Only waive this if the
   resulting file is still clearly organised.

2. **Do not allow random spaghetti growth in existing code.** Be highly
   suspicious of new ad-hoc conditionals, scattered special cases or one-off
   branches inserted into unrelated flows. If a change adds weird `if` statements
   in random places, treat that as a design problem, not a stylistic nit. Prefer
   pushing the logic into a dedicated abstraction, helper, state machine or
   policy object.

3. **Bias toward cleaning the design, not just accepting working code.** If
   behavior can stay the same while the structure becomes meaningfully cleaner,
   push for the cleaner version. Strongly prefer simplifications that remove
   moving pieces over refactors that spread the same complexity around.

4. **Prefer direct, boring, maintainable code over hacky or magical code.** Treat
   brittle, ad-hoc or "magic" behavior as a code-quality problem. Flag thin
   abstractions, identity wrappers and pass-through helpers that add indirection
   without buying clarity.

5. **Push hard on type and boundary cleanliness where they affect
   maintainability.** Question unnecessary optionality, `unknown`, `any` or
   cast-heavy code when a clearer type boundary could exist. If a branch relies
   on silent fallback to paper over an unclear invariant, ask whether the
   boundary should be made explicit instead.

6. **Keep logic in the canonical layer and reuse existing helpers.** Call out
   feature logic leaking into shared paths, or implementation details leaking
   through APIs. Prefer existing canonical utilities over bespoke one-offs.

7. **Treat unnecessary sequential orchestration and non-atomic updates as design
   smells when the cleaner structure is obvious.** If independent work is
   serialised for no good reason, ask whether it should run in parallel. If
   related updates can leave state half-applied, push for a more atomic
   structure.

## Primary Review Questions

- Is there a "code judo" move that would make this dramatically simpler?
- Can this be reframed so fewer concepts, branches or helper layers are needed?
- Did the diff add branching complexity where a better abstraction should exist?
- Did a previously cohesive module become more coupled, more stateful, or harder
  to scan?
- Is this logic living in the right file and layer?
- Are there repeated conditionals that signal a missing model or helper?
- Is this abstraction actually earning its keep, or is it just a wrapper?
- Did the diff introduce casts, optionality or ad-hoc object shapes that obscure
  the real invariant?
- Is this orchestration more sequential or less atomic than it needs to be?

## What to Flag Aggressively

- A complicated implementation where a cleaner reframing could delete whole
  categories of complexity.
- Refactors that move code around but fail to reduce the number of concepts a
  reader must hold in their head.
- New conditionals bolted onto unrelated code paths.
- One-off booleans, nullable modes or flags that complicate existing control flow.
- Feature-specific logic leaking into general-purpose modules.
- Generic "magic" handling that hides simple structure.
- Thin wrappers or identity abstractions that add indirection without simplifying.
- Unnecessary casts, `any`, `unknown` or optional params that muddy the contract.
- Copy-pasted logic instead of extracted helpers.
- "Temporary" branching that is likely to become permanent debt.
- Bespoke helpers where a canonical utility already exists.
- Sequential async flow where independent work could run in parallel.
- Partial-update logic that leaves state less atomic than necessary.

## Preferred Remedies

Delete a layer of indirection rather than polishing it. Reframe the state model
so conditionals disappear. Turn special-case logic into a simpler default flow.
Extract a helper or pure function. Split a large file into focused modules.
Replace condition chains with a typed model or explicit dispatcher. Separate
orchestration from business logic. Collapse duplicate branches into one clearer
flow. Reuse the existing canonical helper. Make type boundaries explicit so the
control flow gets simpler.

Do not be satisfied with "maybe rename this" when the real issue is structural.
Do not be satisfied with a cleaner version of the same messy idea if there is a
plausible path to a much simpler idea.

## Tone

Be direct, serious and demanding about quality. Do not be rude, but do not soften
major maintainability issues into mild suggestions. If the code is making the
codebase messier, say so clearly. If the implementation missed an opportunity for
a dramatic simplification, say that clearly too.

## Output Priority

1. Structural code-quality regressions
2. Missed opportunities for dramatic simplification
3. Spaghetti / branching complexity increases
4. Boundary, abstraction and type-contract problems
5. File-size and decomposition concerns
6. Modularity and abstraction issues
7. Legibility and maintainability concerns

Do not flood the review with low-value nits if there are larger structural
issues. Prefer a small number of high-conviction changes over a long list of
cosmetic notes.

## Approval Bar

Do not approve merely because behavior seems correct. The bar is: no clear
structural regression; no obvious missed opportunity to make the implementation
dramatically simpler; no unjustified file-size explosion; no spaghetti-growth
from special-case branching; no hacky or magical abstraction; no unnecessary
wrapper, cast or optionality churn; no architecture-boundary leak or avoidable
canonical-helper duplication.
