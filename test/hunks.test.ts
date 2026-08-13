import {
  parseDiffHunks,
  classifyHunks,
  reviewGate,
  lintGate,
  touchedLines,
  reviewerDecides,
} from '../src/gate.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

const DIFF = `diff --git a/src/schema.ts b/src/schema.ts
index feccd3e..a6bef75 100644
--- a/src/schema.ts
+++ b/src/schema.ts
@@ -2,7 +2,7 @@ import { z } from 'zod';
 export const User = z.object({
   id: z.string().uuid(),
-  email: z.string().email(),
+  email: z.email(),
   name: z.string(),
 });
@@ -25,7 +25,7 @@ export const Checkout = z.object({
-    metadata: z.record(z.string()),
+    metadata: z.record(z.string(), z.string()),
   })
   .strict();
`;

// ---------------------------------------------------------------------------
// parseDiffHunks — what a harness that writes files leaves behind
// ---------------------------------------------------------------------------

test('a unified diff yields one hunk per changed region, with its file and lines', () => {
  const hunks = parseDiffHunks(DIFF);
  assert.equal(hunks.length, 2);
  assert.equal(hunks[0]?.file, 'src/schema.ts');
  // The @@ header counts from the new file, which is the state on disk and the
  // one the compiler is reporting against.
  assert.equal(hunks[0]?.start, 2);
  assert.equal(hunks[1]?.start, 25);
  assert.ok(hunks[0]?.end >= 2);
});

test('a diff touching nothing yields no hunks', () => {
  assert.deepEqual(parseDiffHunks(''), []);
  assert.deepEqual(parseDiffHunks('diff --git a/x b/x\nindex 1..2 100644\n'), []);
});

test('a deleted file is named by its old side, not by whatever came before it', () => {
  // A deletion has no new side to read the name from. Carrying the previous
  // file's name forward attributes the deletion to a file that was never
  // touched — and the gate reverts by `(file, line)`, so the key it computes
  // would match nothing and an unjustified deletion would land unopposed.
  const diff = `diff --git a/src/keep.ts b/src/keep.ts
--- a/src/keep.ts
+++ b/src/keep.ts
@@ -1,3 +1,3 @@
 a
-b
+c
 d
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-x
-y
`;
  const hunks = parseDiffHunks(diff);
  assert.deepEqual(hunks.map((h) => h.file), ['src/keep.ts', 'src/gone.ts']);
});

test('a file with a header but no hunks does not lend its name to the next one', () => {
  // A mode change or a pure rename carries no hunks. Leaving the name in place
  // is how the next file's hunks end up filed under it.
  const diff = `diff --git a/src/renamed.ts b/src/moved.ts
similarity index 100%
rename from src/renamed.ts
rename to src/moved.ts
diff --git a/src/real.ts b/src/real.ts
--- a/src/real.ts
+++ b/src/real.ts
@@ -7,3 +7,3 @@
 a
-b
+c
 d
`;
  assert.deepEqual(parseDiffHunks(diff).map((h) => h.file), ['src/real.ts']);
});

// ---------------------------------------------------------------------------
// classifyHunks — the same rule the edit gate uses, on a different input
//
// A harness with filesystem access cannot be gated by inspecting proposed
// `find`/`replace` pairs, because it never proposes any: it writes. The only
// artefact left is the diff, so the gate has to read that instead. Same
// question, same evidence, different shape.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The three policies
//
// Under one writer the gate is the only thing between a model and the working
// tree, and the three jobs that write disagree about what justifies a change.
// Flattening them to one rule breaks the two strict ones silently: both review
// and lint run without a single compiler diagnostic, so the migration policy —
// "no diagnostics anywhere, so abstain" — would wave through everything they
// exist to catch.
// ---------------------------------------------------------------------------

const MIGRATION_DIFF = `diff --git a/src/schema.ts b/src/schema.ts
--- a/src/schema.ts
+++ b/src/schema.ts
@@ -24,4 +24,4 @@
   .extend({
-    metadata: z.record(z.string()),
+    metadata: z.record(z.string(), z.string()),
   })
   .strict();
`;

test('review anchors on the migration diff, because it has no diagnostics to anchor on', () => {
  // The pass runs on a build that already passes. Asked to judge from
  // diagnostics it would find none, conclude it cannot judge, and pass the whole
  // diff — including the out-of-scope churn that is the only thing it gates.
  const gate = reviewGate(MIGRATION_DIFF);
  assert.ok(gate.anchors.length > 0, 'the migration diff is the evidence');
  assert.equal(gate.whenNoAnchors, 'judge');

  const inScope = classifyHunks([{ file: 'src/schema.ts', start: 25, end: 27 }], gate);
  assert.equal(inScope[0]?.evidence, 'evidenced');
});

test('a review edit outside the migration diff is churn by definition', () => {
  // Not a judgement call about whether the edit is good. A reviewer gets one
  // attempt; spending it on code the migration never touched spends it on
  // nothing, and buries the change under noise for whoever reads the PR.
  const classified = classifyHunks(
    [{ file: 'src/unrelated.ts', start: 400, end: 402 }],
    reviewGate(MIGRATION_DIFF),
  );
  assert.equal(classified[0]?.evidence, 'unrequested');
});

test('lint reaches past the line it was given; review no longer needs to', () => {
  // Measured difference, not a style choice. A linter names the head of a
  // construct — the `RUN` — while the fix spans its continuations, so lint must
  // reach past the flagged line.
  //
  // Review used to be the strict half of this pair: no window at all, because
  // its anchor WAS the migration's own edit. That bound is gone — it is now
  // scoped by file, since a restructuring is never on the lines the migration
  // happened to touch. See "the reviewer may work anywhere in a file the
  // migration touched" below for the boundary that replaced it.
  const lint = lintGate([{ file: 'Dockerfile', line: 3 }]);
  assert.equal(classifyHunks([{ file: 'Dockerfile', start: 5, end: 5 }], lint)[0]?.evidence, 'evidenced');

  // And lint is still bounded by line, not by file — its findings are the
  // complete list of what is wrong, so distance from them is churn.
  assert.equal(classifyHunks([{ file: 'Dockerfile', start: 40, end: 40 }], lint)[0]?.evidence, 'unrequested');
});

test('lint reverts a change away from every flagged line', () => {
  // The carve-out migration gets — "no call site and no diagnostic here, so
  // there may be a cause Emend cannot see" — is wrong for lint. The findings ARE
  // the complete list of what is wrong with the file, so a change elsewhere is
  // the model rewriting something nobody asked about.
  const classified = classifyHunks(
    [{ file: 'Dockerfile', start: 40, end: 41 }],
    lintGate([{ file: 'Dockerfile', line: 3 }]),
  );
  assert.equal(classified[0]?.evidence, 'unrequested');
});

test('touchedLines counts added lines on the new side', () => {
  // The review gate is only as good as this. Counting the old side, or counting
  // context lines as touched, would anchor the review to lines the migration
  // never changed and quietly restore the churn the gate exists to stop.
  const added = touchedLines(`--- a/x.ts
+++ b/x.ts
@@ -10,4 +10,5 @@
 keep
-old
+new
+extra
 keep
`);
  assert.deepEqual(added, [{ file: 'x.ts', line: 11 }, { file: 'x.ts', line: 12 }]);
});

// ---------------------------------------------------------------------------
// The reviewer judges the repair
// ---------------------------------------------------------------------------

test('the repair gate keeps everything, because the reviewer is what judges it', () => {
  // The deterministic gate never decided this well: its only rule on
  // the repair path was the quiet-call-site one, its only reverts in the whole
  // record were the openai regression, and `unanchored: 'allow'` made every
  // other hunk `evidenced` by construction. Nought caught, three wrongly
  // reverted.
  //
  // What is left is honest about itself. `escalate` requires a gate, and a
  // silently permissive one would read as protection that is not there.
  const diff = `diff --git a/src/schema.ts b/src/schema.ts
--- a/src/schema.ts
+++ b/src/schema.ts
@@ -2,3 +2,3 @@
-const a = z.string().email();
+const a = z.email();
@@ -25,3 +25,3 @@
-z.record(z.string());
+z.record(z.string(), z.unknown());
`;
  const classified = classifyHunks(parseDiffHunks(diff), reviewerDecides());

  assert.ok(
    classified.every((h) => h.evidence === 'evidenced'),
    'nothing the repair wrote is withheld by a line-number rule',
  );
});

test('the reviewer is still held to where it may write, which is a different question', () => {
  // Scope is not judgement. A reviewer that may rewrite anything is not a
  // reviewer, and it is now the component carrying all the trust — so the one
  // thing still worth bounding is its reach, not its opinion.
  //
  // Measured on the 2026-08-13 `--create` run: `review: reverted 1 hunk(s)
  // outside the migration's diff`.
  const migrationDiff = `diff --git a/src/schema.ts b/src/schema.ts
--- a/src/schema.ts
+++ b/src/schema.ts
@@ -25,3 +25,3 @@
-z.record(z.string());
+z.record(z.string(), z.unknown());
`;
  const wandered = [
    { file: 'src/schema.ts', start: 25, end: 27 },
    { file: 'src/unrelated.ts', start: 90, end: 92 },
  ];
  const classified = classifyHunks(wandered, reviewGate(migrationDiff));

  assert.equal(classified[0]?.evidence, 'evidenced', 'inside the migration it may speak');
  assert.equal(classified[1]?.evidence, 'unrequested', 'outside it, it may not');
});

test('the reviewer may work anywhere in a file the migration touched', () => {
  // Widened deliberately. The quality skill asks for restructuring — extract a
  // helper, split a file, collapse a branch — and a line-level anchor reverts
  // every one of those on arrival, because the better shape is by definition not
  // on the lines the migration happened to change. A reviewer whose every
  // suggestion is undone before verification is a reviewer in name.
  //
  // Still bounded, and the bound is the one that matters: a file the migration
  // never opened is not this pass's business. Verification remains the judge of
  // whether the restructuring was any good, and reverts the lot if it was not.
  const migrationDiff = `diff --git a/src/schema.ts b/src/schema.ts
--- a/src/schema.ts
+++ b/src/schema.ts
@@ -25,3 +25,3 @@
-z.record(z.string());
+z.record(z.string(), z.unknown());
`;
  const classified = classifyHunks(
    [
      { file: 'src/schema.ts', start: 25, end: 27 },
      { file: 'src/schema.ts', start: 4, end: 9 },
      { file: 'src/unrelated.ts', start: 90, end: 92 },
    ],
    reviewGate(migrationDiff),
  );

  assert.equal(classified[0]?.evidence, 'evidenced', 'on the migration’s own lines');
  assert.equal(classified[1]?.evidence, 'evidenced', 'elsewhere in the same file — the comment case');
  assert.equal(classified[2]?.evidence, 'unrequested', 'a file the migration never opened');
});
