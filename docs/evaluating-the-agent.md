# Measuring the agent

Back to the [README](../README.md).

---

Prompt changes are cheap to make and hard to judge. `emend eval` runs a corpus of
real migrations and scores them:

```
$ emend eval --model z-ai/glm-5.2,qwen/qwen3-coder --repeat 3

| Model | Cases | Runs | Pass | Clean | Unresolved | Edit ratio | Withheld | ... |
```

**`Pass` and `Clean` are deliberately different columns.** A green build says the
migration compiles and the tests pass. It says nothing about whether the model
changed things nobody asked about, bought the green with `any`, or shipped a
commit titled *"migrate `Cell`"* without removing a single use of `Cell`. Every
failure this project has actually hit lived in that gap.

**`Unresolved` is whether the migration finished. `Edit ratio` is reported and
never scored.** Each case declares the pre-migration forms a finished migration
removes, and `Unresolved` counts the ones still there — that is the completeness
signal. The ratio divides diff hunks by logical edits, and hunks merge when
changes land near each other, so a *complete* zod migration reads "4 of 6" and did
so for an entire sweep before anyone noticed. It is a signal about scope, read
alongside the other columns rather than on its own, and nothing is judged against
it in either direction: the review pass exists to edit, so charging it for editing
would measure the design rather than the model.

Migrations vary between runs, so `--repeat` is how you tell a real change from
noise.

---
