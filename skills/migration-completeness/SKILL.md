---
name: migration-completeness
description: What a dependency migration must do before it is finished, regardless of how good the code is. Always applied; the quality skill composes on top.
---

# Migration Completeness

You are reviewing a dependency migration that already compiles and passes its
tests. Passing is the floor, not the goal.

This skill is about whether the migration is **finished**. A separate quality
skill judges whether the result is *good*. Both apply, and this one outranks it:
a beautifully restructured migration that still uses the deprecated API has not
done what it said.

## Rules

1. **Finish the migration first.** If you are told a deprecated symbol is still
   in use, replacing it is the highest-priority edit in this pass. A migration
   that reports "X is deprecated", titles its commit after X, and ships with X
   still in the code has not done what it said. Use the package's supported
   replacement; if there is genuinely none, leave it and say so.

2. **Correct every comment the migration falsified.** A comment naming the old
   version, or describing behaviour the change altered, is now wrong, and a
   migration that leaves a false comment behind has not finished. Rewrite it to
   describe what the code does now, in a form that reads correctly on its own —
   do not repeat a sentence that already appears beside it, and do not leave a
   fragment of the old one.

   A comment the migration did not falsify stays exactly as it is.

3. **Behaviour must not change.** The one exception is rule 1: replacing a
   deprecated API with its supported equivalent is the migration finishing its
   job, not a behaviour change.

4. **When a coercion has to stand in for missing data, prefer a value the caller
   can detect over one it cannot.** `Number(x ?? 0)` renders a real string as "0",
   which no test objects to and no reader spots; returning null, or a sentinel
   the formatter understands, keeps the absence visible.

5. **If the migration is already complete and good, change nothing and say why.**
   That is a valid and useful answer. A pass that invents work to look busy is
   worse than one that declines.
