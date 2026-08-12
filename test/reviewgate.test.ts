import test from 'node:test';
import assert from 'node:assert/strict';
import { touchedLines, selectReviewEdits } from '../src/llm/propose.ts';
import type { TextEdit } from '../src/llm/propose.ts';

// The real diff from the live axios repair, trimmed to the file that matters.
const MIGRATION_DIFF = `diff --git a/src/client.ts b/src/client.ts
index 873b4b2..51601ec 100644
--- a/src/client.ts
+++ b/src/client.ts
@@ -1,4 +1,4 @@
-import axios, { AxiosRequestConfig, AxiosResponse, AxiosTransformer, CancelTokenSource } from 'axios';
+import axios, { AxiosRequestConfig, AxiosResponse, AxiosResponseTransformer, CancelTokenSource } from 'axios';
 
 export interface Charge {
   id: string;
@@ -8,7 +8,7 @@ export interface Charge {
 const client = axios.create({ baseURL: 'https://api.example.com', timeout: 5000 });
 
 /** Normalise the vendor's cent amounts before anything downstream sees them. */
-const centsToUnits: AxiosTransformer = (data: unknown) => {
+const centsToUnits: AxiosResponseTransformer = (data: unknown) => {
   if (typeof data !== 'string') return data;
   const parsed = JSON.parse(data) as { amount?: number };
`;

const SOURCE = [
  "import axios, { AxiosRequestConfig, AxiosResponse, AxiosResponseTransformer, CancelTokenSource } from 'axios';", // 1
  '',                                                                        // 2
  'export interface Charge {',                                               // 3
  '  id: string;',                                                           // 4
  '  amount: number;',                                                       // 5
  '}',                                                                       // 6
  '',                                                                        // 7
  "const client = axios.create({ baseURL: 'https://api.example.com' });",    // 8
  '',                                                                        // 9
  '/** Normalise the vendor cent amounts. */',                               // 10
  'const centsToUnits: AxiosResponseTransformer = (data: unknown) => {',     // 11
  "  if (typeof data !== 'string') return data;",                            // 12
  '  const parsed = JSON.parse(data) as { amount?: number };',               // 13
  "  if (typeof parsed.amount === 'number') parsed.amount /= 100;",          // 14
  '  return parsed;',                                                        // 15
  '};',                                                                      // 16
  '',                                                                        // 17
  'export async function fetchCharge(id: string, cancel: CancelTokenSource): Promise<Charge> {', // 18
  '  const config: AxiosRequestConfig = {',                                  // 19
  '    transformResponse: [centsToUnits],',                                  // 20
  '    cancelToken: cancel.token,',                                          // 21
  '  };',                                                                    // 22
  '  return (await client.get(`/v1/charges/${id}`, config)).data;',          // 23
  '}',                                                                       // 24
].join('\n');

const SOURCES = new Map([['src/client.ts', SOURCE]]);
const edit = (find: string, replace: string): TextEdit => ({
  file: 'src/client.ts', find, replace, reason: 'review',
});

// ---------------------------------------------------------------------------
// Reading what the migration actually touched
// ---------------------------------------------------------------------------

test('the lines a migration changed are read out of its own diff', () => {
  const touched = touchedLines(MIGRATION_DIFF);
  assert.deepEqual(touched, [
    { file: 'src/client.ts', line: 1 },
    { file: 'src/client.ts', line: 11 },
  ]);
});

test('the +++ header is not counted as an added line', () => {
  // It begins with '+' and would otherwise anchor the gate to line 0 of every
  // file, which quietly turns the gate off.
  const touched = touchedLines(MIGRATION_DIFF);
  assert.ok(touched.every((t) => t.line > 0));
  assert.ok(touched.every((t) => !t.file.startsWith('b/')));
});

test('context and deleted lines keep the new-file numbering honest', () => {
  // A deletion consumes no line on the new side; a context line does. Getting
  // this backwards shifts every anchor after the first hunk.
  const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,4 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
 const c = 4;
`;
  assert.deepEqual(touchedLines(diff), [{ file: 'a.ts', line: 2 }]);
});

// ---------------------------------------------------------------------------
// What the review may change
// ---------------------------------------------------------------------------

test('a review edit on a line the migration changed is kept', () => {
  const { keep, dropped } = selectReviewEdits(
    [edit('AxiosResponseTransformer = (data: unknown)', 'AxiosResponseTransformer = (data)')],
    MIGRATION_DIFF,
    [],
    SOURCES,
  );
  assert.equal(keep.length, 1);
  assert.equal(dropped.length, 0);
});

test('the measured churn is withheld', () => {
  // Live, with the review ungated: it rewrote a working `cancelToken:
  // CancelTokenSource` into `signal: AbortSignal`, changing an EXPORTED
  // function's signature. `cancelToken` carries no deprecated tag in axios
  // 0.33.0, so this finished no migration. The build stayed green and the
  // advisory stayed cleared, which is exactly why verification cannot catch it.
  const { keep, dropped } = selectReviewEdits(
    [
      edit('cancel: CancelTokenSource', 'signal: AbortSignal'),
      edit('cancelToken: cancel.token,', 'signal,'),
    ],
    MIGRATION_DIFF,
    [],
    SOURCES,
  );
  assert.deepEqual(keep, []);
  assert.equal(dropped.length, 2);
  assert.match(dropped[0]?.reason ?? '', /the migration did not touch/);
});

test('finishing a reported deprecation is in scope wherever it lives', () => {
  // Review rule 4 outranks rule 6: a migration that reports "X is deprecated"
  // and ships with X still in the code has not done what it said. That edit is
  // the review's highest-priority job and must survive a gate built to stop it
  // wandering.
  const { keep } = selectReviewEdits(
    [edit('cancel: CancelTokenSource', 'signal: AbortSignal')],
    MIGRATION_DIFF,
    [{ file: 'src/client.ts', line: 18 }],
    SOURCES,
  );
  assert.equal(keep.length, 1);
});

test('an edit that cannot be located is left for the applicator to refuse', () => {
  // One place decides, one reason is reported — same contract as the lint gate.
  const { keep } = selectReviewEdits(
    [edit('NOT PRESENT ANYWHERE', 'x')],
    MIGRATION_DIFF,
    [],
    SOURCES,
  );
  assert.equal(keep.length, 1);
});

test('a review with no migration diff may change nothing', () => {
  // Nothing was touched, so nothing is in scope. The failure mode this replaces
  // is an unanchored review free-running over the whole file.
  const { keep, dropped } = selectReviewEdits(
    [edit('cancel: CancelTokenSource', 'signal: AbortSignal')],
    '',
    [],
    SOURCES,
  );
  assert.deepEqual(keep, []);
  assert.equal(dropped.length, 1);
});

test('the review must overlap a changed line, not merely sit near one', () => {
  // Deliberately stricter than the lint gate. There, a linter names the head of
  // a construct and the fix spans its continuations, so a window is necessary.
  // Here the anchor IS the migration's own edit, and a review improving that
  // edit overlaps it — `spanOf` already covers the multi-line case. A window
  // would licence exactly the drift this gate exists to stop: three lines is
  // enough to reach the next statement.
  const { keep, dropped } = selectReviewEdits(
    [edit('  const parsed = JSON.parse(data)', '  const parsed: unknown = JSON.parse(data)')], // line 13, nearest anchor 11
    MIGRATION_DIFF,
    [],
    SOURCES,
  );
  assert.deepEqual(keep, []);
  assert.equal(dropped.length, 1);
});
