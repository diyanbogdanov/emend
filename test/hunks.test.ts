import {
  parseDiffHunks,
  classifyHunks,
  migrationGate,
  reviewGate,
  lintGate,
  touchedLines,
  maskedFiles,
} from '../src/gate.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { CallSite, SurfaceChange } from '../src/types.ts';

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

function change(path: string, kind: SurfaceChange['kind']): SurfaceChange {
  return {
    path,
    kind,
    severity: kind === 'deprecated' ? 'deprecation' : 'breaking',
    confidence: 'high',
    before: 'before',
    after: 'after',
  };
}

function site(line: number): CallSite {
  return { file: 'src/schema.ts', line, column: 3, text: '', via: 'import' };
}

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

const CHANGES = [
  { change: change('record', 'signature-changed'), sites: [site(25)] },
  { change: change('ZodString.email', 'deprecated'), sites: [site(4)] },
];

// Only `record` breaks the build; the deprecation compiles.
const FAILURE = 'src/schema.ts(25,15): error TS2554: Expected 2 arguments, but got 1.';

test('a hunk a diagnostic points into is evidenced', () => {
  const classified = classifyHunks(parseDiffHunks(DIFF), migrationGate(CHANGES, FAILURE));
  const recordHunk = classified.find((h) => h.hunk.start === 25);
  assert.equal(recordHunk?.evidence, 'evidenced');
});

test('a hunk over a quiet call site is unrequested', () => {
  const classified = classifyHunks(parseDiffHunks(DIFF), migrationGate(CHANGES, FAILURE));
  const emailHunk = classified.find((h) => h.hunk.start === 2);
  assert.equal(emailHunk?.evidence, 'unrequested');
});

test('a hunk over a deprecation still present is evidenced', () => {
  // Same carve-out the edit gate has. A deprecated call never produces a
  // diagnostic, so a diagnostic-only rule would cancel the migration the finding
  // asked for.
  const classified = classifyHunks(parseDiffHunks(DIFF), migrationGate(CHANGES, FAILURE, new Set(['ZodString.email'])));
  const emailHunk = classified.find((h) => h.hunk.start === 2);
  assert.equal(emailHunk?.evidence, 'evidenced');
});

test('with no diagnostics anywhere the gate abstains', () => {
  // A failing test suite reports no locations, so there is no positive evidence
  // for anything. Judging from silence is how a gate starts withholding real
  // repairs.
  const classified = classifyHunks(parseDiffHunks(DIFF), migrationGate(CHANGES, 'FAIL  test/checkout.test.ts'));
  assert.ok(classified.every((h) => h.evidence === 'evidenced'));
});

test('a hunk in a file with no call site and no diagnostic is left alone', () => {
  // The Dockerfile case: a bump can break a file the call-site walk never
  // visits, and Emend has no evidence either way there.
  const diff = `diff --git a/Dockerfile b/Dockerfile
--- a/Dockerfile
+++ b/Dockerfile
@@ -1,2 +1,2 @@
-FROM node:18
+FROM node:22
`;
  const classified = classifyHunks(parseDiffHunks(diff), migrationGate(CHANGES, FAILURE));
  assert.equal(classified[0]?.evidence, 'evidenced');
});

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

test('review allows itself no window, where lint needs one', () => {
  // Measured difference, not a style choice. A linter names the head of a
  // construct — the `RUN` — while the fix spans its continuations, so lint must
  // reach past the flagged line. Review's anchor IS the migration's own edit, so
  // an improvement to it already overlaps; three lines of slack there is enough
  // to reach the next statement, which is the drift being prevented.
  const nearby = [{ file: 'src/schema.ts', start: 28, end: 28 }];
  assert.equal(classifyHunks(nearby, reviewGate(MIGRATION_DIFF))[0]?.evidence, 'unrequested');

  const lint = lintGate([{ file: 'Dockerfile', line: 3 }]);
  assert.equal(classifyHunks([{ file: 'Dockerfile', start: 5, end: 5 }], lint)[0]?.evidence, 'evidenced');
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

test('migration still abstains when the failure names no locations at all', () => {
  // The policy that must NOT be flattened into the other two. A failing test
  // suite reports no file:line anywhere, and reverting everything on that basis
  // turns a possible repair into a guaranteed no-op.
  const gate = migrationGate(CHANGES, 'FAIL  test/checkout.test.ts');
  assert.equal(gate.whenNoAnchors, 'abstain');
  const classified = classifyHunks(parseDiffHunks(DIFF), gate);
  assert.ok(classified.every((h) => h.evidence === 'evidenced'));
});

test('a call site downstream of a broken import is not "the compiler is content"', () => {
  // The openai 3 -> 4 regression, reduced. The harness migrated the file
  // correctly in four places; the gate reverted three of them as "covers a call
  // site with nothing outstanding on it", because the failed import on line 1
  // meant lines 7, 22 and 30 carried no diagnostic of their own. What shipped
  // was the new import over the old call shapes — more broken than the file it
  // started from, and scored as a regression the model had actually repaired.
  //
  // This is the cardinal rule turned on the gate itself. Emend refuses to read
  // silence as cleanliness about a call site it cannot parse or a route no
  // description covers; a quiet line downstream of an unresolved import is the
  // same inference, made by the one component that decides what may land.
  // `site()` files everything under src/schema.ts, so the import error names it.
  const importError =
    "src/schema.ts(1,10): error TS2614: Module '\"openai\"' has no exported member 'Configuration'.";
  const changes = [
    { change: change('OpenAIApi', 'signature-changed'), sites: [site(22)] },
  ];

  assert.deepEqual([...maskedFiles(importError)], ['src/schema.ts']);

  const gate = migrationGate(changes, importError);
  assert.equal(gate.quiet?.length, 0, 'a masked file contributes no quiet lines');

  // Neither anchored nor quiet, so it falls through to `allow` and verification
  // decides — which is the honest answer when nothing was actually checked.
  const classified = classifyHunks([{ file: 'src/schema.ts', start: 22, end: 23 }], gate);
  assert.equal(classified[0]?.evidence, 'evidenced');
});

test('an ordinary type error does not mask the rest of its file', () => {
  // The narrowness matters. A TS2554 at line 25 does not stop the compiler
  // reading line 4, so the quiet rule still applies there — otherwise one error
  // anywhere in a file would licence editing all of it.
  assert.equal(maskedFiles('src/schema.ts(25,15): error TS2554: Expected 2 arguments.').size, 0);
  const gate = migrationGate(CHANGES, FAILURE);
  assert.ok((gate.quiet?.length ?? 0) > 0, 'unmasked files still contribute quiet lines');
});
