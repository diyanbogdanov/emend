import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDiffHunks, classifyHunks } from '../src/llm/agent.ts';
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
  const classified = classifyHunks(parseDiffHunks(DIFF), CHANGES, FAILURE);
  const recordHunk = classified.find((h) => h.hunk.start === 25);
  assert.equal(recordHunk?.evidence, 'evidenced');
});

test('a hunk over a quiet call site is unrequested', () => {
  const classified = classifyHunks(parseDiffHunks(DIFF), CHANGES, FAILURE);
  const emailHunk = classified.find((h) => h.hunk.start === 2);
  assert.equal(emailHunk?.evidence, 'unrequested');
});

test('a hunk over a deprecation still present is evidenced', () => {
  // Same carve-out the edit gate has. A deprecated call never produces a
  // diagnostic, so a diagnostic-only rule would cancel the migration the finding
  // asked for.
  const classified = classifyHunks(parseDiffHunks(DIFF), CHANGES, FAILURE, new Set(['ZodString.email']));
  const emailHunk = classified.find((h) => h.hunk.start === 2);
  assert.equal(emailHunk?.evidence, 'evidenced');
});

test('with no diagnostics anywhere the gate abstains', () => {
  // A failing test suite reports no locations, so there is no positive evidence
  // for anything. Judging from silence is how a gate starts withholding real
  // repairs.
  const classified = classifyHunks(parseDiffHunks(DIFF), CHANGES, 'FAIL  test/checkout.test.ts');
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
  const classified = classifyHunks(parseDiffHunks(diff), CHANGES, FAILURE);
  assert.equal(classified[0]?.evidence, 'evidenced');
});
