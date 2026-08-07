import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nearbySymbols,
  classifyEdits,
  selectEvidencedEdits,
  parseDiagnostics,
  buildUserPrompt,
  MIGRATION_SYSTEM_PROMPT,
  TIGHTENING_SYSTEM_PROMPT,
  NARROWING_RULE,
  type TextEdit,
} from '../src/llm/agent.ts';
import type { CallSite, Finding, SurfaceChange } from '../src/types.ts';

function targetSymbols(
  entries: Array<[string, boolean?]>,
): Record<string, { path: string; deprecated: boolean }> {
  return Object.fromEntries(
    entries.map(([path, deprecated]) => [path, { path, deprecated: deprecated === true }]),
  );
}

// ---------------------------------------------------------------------------
// nearbySymbols
// ---------------------------------------------------------------------------

test('offers a symbol that moved to a different container', () => {
  // A migration that relocates a helper is a stated tier-2 target. Ranking only
  // within the changed symbol's own container means the replacement is filtered
  // out before scoring ever sees it, so the model is told to use "only symbols
  // from this list" and the list cannot contain the answer.
  const candidates = nearbySymbols(
    'record',
    targetSymbols([['object'], ['string'], ['core.record'], ['number']]),
  );
  assert.ok(
    candidates.includes('core.record'),
    `a relocated symbol must be offered; got ${JSON.stringify(candidates)}`,
  );
});

test('ranks a relocated exact match above unrelated same-container symbols', () => {
  const candidates = nearbySymbols(
    'record',
    targetSymbols([['object'], ['string'], ['core.record'], ['number']]),
  );
  assert.ok(
    candidates.indexOf('core.record') < candidates.indexOf('object'),
    `relocated exact match must outrank unrelated siblings; got ${JSON.stringify(candidates)}`,
  );
});

test('still ranks a same-container near-name match near the front', () => {
  // Regression guard: zod 4's `partialRecord` replaces a broken `record` call and
  // was once buried past the prompt's cutoff by alphabetical ordering.
  const candidates = nearbySymbols(
    'record',
    targetSymbols([['array'], ['bigint'], ['object'], ['partialRecord'], ['string']]),
  );
  assert.ok(
    candidates.indexOf('partialRecord') < 2,
    `partialRecord must stay near the front; got ${JSON.stringify(candidates)}`,
  );
});

test('never offers a deprecated symbol as a replacement', () => {
  const candidates = nearbySymbols(
    'record',
    targetSymbols([['partialRecord', true], ['object']]),
  );
  assert.ok(!candidates.includes('partialRecord'));
});

// ---------------------------------------------------------------------------
// classifyEdits / selectEvidencedEdits
// ---------------------------------------------------------------------------

const SCHEMA_SOURCE = `import { z } from 'zod';

export const User = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  metadata: z.record(z.string()),
});
`;

function change(path: string, kind: SurfaceChange['kind']): SurfaceChange {
  return {
    path,
    kind,
    severity: kind === 'deprecated' ? 'deprecation' : 'breaking',
    confidence: 'high',
    before: 'before',
    after: kind === 'removed' ? null : 'after',
  };
}

function site(line: number, text: string): CallSite {
  return { file: 'src/schema.ts', line, column: 3, text, via: 'import' };
}

const CHANGES = [
  { change: change('record', 'signature-changed'), sites: [site(6, 'metadata: z.record(z.string()),')] },
  { change: change('ZodString.email', 'deprecated'), sites: [site(5, 'email: z.string().email(),')] },
  { change: change('ZodString.uuid', 'deprecated'), sites: [site(4, 'id: z.string().uuid(),')] },
];

const SOURCES = new Map([['src/schema.ts', SCHEMA_SOURCE]]);

// Only `record` actually breaks the build. The deprecations compile fine.
const FAILURE = `src/schema.ts(6,15): error TS2554: Expected 2 arguments, but got 1.`;

function edit(find: string, replace: string): TextEdit {
  return { file: 'src/schema.ts', find, replace, reason: 'test' };
}

test('an edit at a call site the compiler is complaining about is evidenced', () => {
  const [classified] = classifyEdits(
    [edit('z.record(z.string())', 'z.record(z.string(), z.unknown())')],
    CHANGES,
    FAILURE,
    SOURCES,
  );
  assert.equal(classified?.evidence, 'evidenced');
});

test('an edit at a call site the compiler is silent about is unrequested', () => {
  // The measured over-editing failure: asked to fix a `z.record` arity break,
  // models also rewrote `.uuid()` and `.email()` across the deprecation
  // findings. Those edits compile and pass tests, so verification cannot catch
  // them — they alter runtime error messages nobody asked to change.
  const [classified] = classifyEdits(
    [edit('.uuid()', ".uuid({ message: 'Invalid UUID' })")],
    CHANGES,
    FAILURE,
    SOURCES,
  );
  assert.equal(classified?.evidence, 'unrequested');
});

test('an edit in a file with no known call site is evidenced, not dropped', () => {
  // a scanned repository asserts its Dockerfile's image tag matches package.json, so the
  // bump breaks a file the call-site walk never visits. Emend has no evidence
  // either way there, and dropping it would lose a real repair.
  const [classified] = classifyEdits(
    [{ file: 'Dockerfile', find: 'playwright:v1.62.1', replace: 'playwright:v1.63.0', reason: 'test' }],
    CHANGES,
    FAILURE,
    new Map([['Dockerfile', 'FROM mcr.microsoft.com/playwright:v1.62.1\n']]),
  );
  assert.equal(classified?.evidence, 'evidenced');
});

test('unrequested edits are dropped when evidenced edits exist alongside them', () => {
  const classified = classifyEdits(
    [
      edit('z.record(z.string())', 'z.record(z.string(), z.unknown())'),
      edit('.uuid()', ".uuid({ message: 'Invalid UUID' })"),
      edit('.email()', ".email({ message: 'Invalid email' })"),
    ],
    CHANGES,
    FAILURE,
    SOURCES,
  );
  const { keep, dropped } = selectEvidencedEdits(classified);
  assert.equal(keep.length, 1);
  assert.equal(keep[0]?.find, 'z.record(z.string())');
  assert.equal(dropped.length, 2);
});

test('an edit removing a still-imported deprecated symbol is not withheld', () => {
  // The recharts case from PR #2: Emend reported `Cell` as deprecated, titled a
  // commit "migrate `Cell`", and shipped without removing a single use of it.
  // Nothing objected, because deprecated code compiles and its tests pass.
  //
  // A diagnostic-only gate would make that permanent: there is never a compiler
  // error on a deprecated call, so the edit that resolves the finding looks
  // exactly like the churn this gate exists to withhold. Still being imported is
  // the evidence that distinguishes them, and it is measured, not asked for.
  const source = [
    "import { BarChart, Bar, Cell } from 'recharts';", // 1
    '', // 2
    'export const chart = <BarChart data={d}><Bar /><Cell fill="#000" /></BarChart>;', // 3
  ].join('\n');
  const changes = [
    {
      change: change('Cell', 'deprecated'),
      sites: [{ file: 'src/chart.tsx', line: 3, column: 48, text: '<Cell fill="#000" />', via: 'import' as const }],
    },
  ];
  const classified = classifyEdits(
    [{ file: 'src/chart.tsx', find: '<Cell fill="#000" />', replace: '', reason: 'test' }],
    changes,
    'src/chart.tsx(1,10): error TS2305: Module has no exported member.',
    new Map([['src/chart.tsx', source]]),
    new Set(['Cell']),
  );
  assert.equal(classified[0]?.evidence, 'evidenced');
});

test('a deprecation the migration already resolved stops evidencing further edits', () => {
  // Once the symbol is gone the finding is settled, so a later attempt editing
  // that same line is churn again. The set is recomputed from the files as they
  // stand, so this follows automatically rather than needing its own rule.
  const classified = classifyEdits(
    [edit('.uuid()', ".uuid({ message: 'Invalid UUID' })")],
    CHANGES,
    FAILURE,
    SOURCES,
    new Set(), // nothing outstanding
  );
  assert.equal(classified[0]?.evidence, 'unrequested');
});

test('nothing is withheld when the failure carries no diagnostics at all', () => {
  // A failing test suite reports no `file(line,col): error`, so there is no
  // positive evidence for any location. An edit elsewhere in the file would then
  // be "evidenced" purely by absence of information, and would be enough to
  // start dropping real call-site edits. With no diagnostics the gate knows
  // nothing and must say nothing.
  const classified = classifyEdits(
    [
      edit('.uuid()', ".uuid({ message: 'Invalid UUID' })"),
      edit("import { z } from 'zod';", "import { z } from 'zod/v4';"),
    ],
    CHANGES,
    'FAIL  test/checkout.test.ts > rejects malformed input\n  expected 1 error, got 0',
    SOURCES,
  );
  const { keep, dropped } = selectEvidencedEdits(classified);
  assert.equal(dropped.length, 0, 'no diagnostics means no grounds to withhold anything');
  assert.equal(keep.length, 2);
});

test('every edit is kept when none of them can be evidenced', () => {
  // Fail open. If Emend cannot tell which edits are supported, the model's guess
  // is all there is and verification is the judge — silently dropping everything
  // would turn a possible repair into a guaranteed no-op.
  const classified = classifyEdits(
    [edit('.uuid()', ".uuid({ message: 'Invalid UUID' })")],
    CHANGES,
    FAILURE,
    SOURCES,
  );
  const { keep, dropped } = selectEvidencedEdits(classified);
  assert.equal(keep.length, 1);
  assert.equal(dropped.length, 0);
});

// ---------------------------------------------------------------------------
// The measured over-editing case, on real data.
//
// Source and line numbers are the demo repository's `src/schema.ts`; the
// diagnostics are the literal output of `tsc --noEmit` after bumping zod
// 3.22.4 -> 4.4.3. Two symbols break the build (`record` at line 28,
// `ZodError.errors` at line 41) and three deprecations do not. The docs record
// what models do with this: they also rewrite `.uuid()`, `.email()` and
// `.datetime()`, producing six edits where two are required. Those extra edits
// compile and pass the tests, so nothing downstream can reject them.
// ---------------------------------------------------------------------------

const DEMO_SCHEMA = [
  "import { z } from 'zod';", // 1
  '', // 2
  '/**', // 3
  ' * Validation schemas for the checkout service.', // 4
  ' *', // 5
  ' * Written against zod 3.x.', // 6
  ' */', // 7
  '', // 8
  '', // 9
  'export const CustomerSchema = z.object({', // 10
  '  id: z.string().uuid(),', // 11
  '  email: z.string().email(),', // 12
  '  name: z.string().min(1).max(200),', // 13
  '  createdAt: z.string().datetime(),', // 14
  '});', // 15
  ...Array.from({ length: 12 }, () => ''), // 16-27
  '    metadata: z.record(z.string()),', // 28
  '  })', // 29
  ...Array.from({ length: 11 }, () => ''), // 30-40
  '  return result.error.errors.map((i) => i.message);', // 41
  '}', // 42
].join('\n');

const DEMO_DIAGNOSTICS = [
  'src/schema.ts(28,17): error TS2554: Expected 2-3 arguments, but got 1.',
  "src/schema.ts(41,23): error TS2339: Property 'errors' does not exist on type 'ZodError<...>'.",
  "src/schema.ts(41,35): error TS7006: Parameter 'issue' implicitly has an 'any' type.",
].join('\n');

const DEMO_CHANGES = [
  { change: change('record', 'signature-changed'), sites: [site(28, 'metadata: z.record(z.string()),')] },
  { change: change('ZodError.errors', 'removed'), sites: [site(41, 'return result.error.errors.map(...)')] },
  { change: change('ZodString.uuid', 'deprecated'), sites: [site(11, 'id: z.string().uuid(),')] },
  { change: change('ZodString.email', 'deprecated'), sites: [site(12, 'email: z.string().email(),')] },
  { change: change('ZodString.datetime', 'deprecated'), sites: [site(14, 'createdAt: z.string().datetime(),')] },
];

test('the six-edit over-edit is reduced to the two edits the compiler asked for', () => {
  const proposed: TextEdit[] = [
    edit('z.record(z.string())', 'z.record(z.string(), z.unknown())'),
    edit('result.error.errors', 'result.error.issues'),
    edit('.uuid()', ".uuid({ message: 'Invalid UUID' })"),
    edit('.email()', ".email({ message: 'Invalid email' })"),
    edit('.datetime()', ".datetime({ message: 'Invalid datetime' })"),
  ];

  const classified = classifyEdits(
    proposed,
    DEMO_CHANGES,
    DEMO_DIAGNOSTICS,
    new Map([['src/schema.ts', DEMO_SCHEMA]]),
  );
  const { keep, dropped } = selectEvidencedEdits(classified);

  assert.deepEqual(
    keep.map((e) => e.find),
    ['z.record(z.string())', 'result.error.errors'],
    'only the two edits a diagnostic points at may survive',
  );
  assert.equal(dropped.length, 3, 'all three deprecation rewrites must be withheld');
});

// ---------------------------------------------------------------------------
// The narrowing rule belongs to every prompt that can hit a union
// ---------------------------------------------------------------------------

test('the prompt shows the guidance a deprecated declaration gives', () => {
  // Without it the model is handed a signature and a symbol list, and the
  // recharts migration is neither — `Cell` becomes a `shape` prop. Every run
  // declined it for the same stated reason: no replacement in the available
  // symbols. That reason was correct and the answer was in the declaration.
  const guidance = 'Please use the `shape` prop or `content` prop instead of using `Cell`.';
  const prompt = buildUserPrompt({
    finding: FINDING,
    changes: [
      {
        change: { ...change('Cell', 'deprecated'), guidance },
        sites: [site(3, '<Cell fill={c} />')],
      },
    ],
    sources: SOURCES,
    candidateSymbols: [],
  });
  assert.ok(prompt.includes(guidance), 'the declaration says what to do; the prompt must repeat it');
});

test('the migration prompt says a listed deprecation is in scope', () => {
  // Measured across twelve runs: the dominant failure is not over-editing but
  // under-editing — deprecations reported in the finding list and left in the
  // code. Two rules cause it. Rule 3 says change only what the API changes
  // require, and the failure section says not to edit call sites the compiler
  // does not name. A deprecation never appears in compiler output, so both read
  // as "leave it".
  //
  // The review pass exists to catch this afterwards and sometimes reverts. The
  // cheaper fix is to stop asking for the wrong thing in the first place.
  assert.match(MIGRATION_SYSTEM_PROMPT, /deprecat/i);
  // And the failure section must not contradict it.
  const prompt = buildUserPrompt({
    finding: FINDING,
    changes: CHANGES,
    sources: SOURCES,
    candidateSymbols: [],
    failureOutput: FAILURE,
  });
  assert.match(prompt, /deprecat/i, 'the failure section must carve out the deprecations it lists');
});

test('the migration prompt carries the same narrowing rule as tightening', () => {
  // #1 disclosed this as a known gap: the narrowing rules lived only in the
  // tightening prompt, so a migration that had to handle a union wrote
  // `Number(value)` unguided. The recharts case reproduced it on the first run —
  // `formatRevenue(Number(value))` where the value is `ValueType | undefined`,
  // rendering `$NaN` for a missing one while typechecking and passing every
  // test. Nothing downstream can catch that, because it is not a type error.
  //
  // Asserted on both prompts against one shared constant, because two copies of
  // a rule this specific drift, and the copy that drifts is the one nobody is
  // looking at.
  assert.ok(MIGRATION_SYSTEM_PROMPT.includes(NARROWING_RULE));
  assert.ok(TIGHTENING_SYSTEM_PROMPT.includes(NARROWING_RULE));
  // The two failure modes it exists to name.
  assert.match(NARROWING_RULE, /NaN/);
  assert.match(NARROWING_RULE, /typeof/);
});

// ---------------------------------------------------------------------------
// parseDiagnostics
//
// `failureSize` in fix.ts already counts errors for the keep-or-rollback rule.
// This extracts their *locations*, which counting cannot give and the evidence
// gate cannot work without.
// ---------------------------------------------------------------------------

test('extracts the file and line each diagnostic points at', () => {
  const output = [
    'src/schema.ts(6,15): error TS2554: Expected 2 arguments, but got 1.',
    "src/schema.ts(41,23): error TS2339: Property 'errors' does not exist.",
    'src/api.ts:12:5: error  Argument of type ... is not assignable.',
  ].join('\n');
  assert.deepEqual(parseDiagnostics(output), [
    { file: 'src/schema.ts', line: 6 },
    { file: 'src/schema.ts', line: 41 },
    { file: 'src/api.ts', line: 12 },
  ]);
});

test('reports no locations for output that carries no diagnostics', () => {
  assert.deepEqual(parseDiagnostics('All tests passed.\n'), []);
});

// ---------------------------------------------------------------------------
// prompt construction
// ---------------------------------------------------------------------------

const FINDING: Finding = {
  id: 'test',
  detector: 'npm-surface',
  pkg: 'zod',
  fromVersion: '3.22.4',
  toVersion: '4.4.3',
  change: change('record', 'signature-changed'),
  sites: [site(6, 'metadata: z.record(z.string()),')],
  confidence: 'high',
};

test('the prompt states what is currently broken even before any attempt', () => {
  // The compiler output is the authority on what still needs fixing, and it
  // exists before the model has tried anything — the deterministic phase already
  // ran and failed. Smuggling it in as a zero-edit "previous attempt" reads as
  // "you tried nothing and it did not work" once real attempts accumulate.
  const prompt = buildUserPrompt({
    finding: FINDING,
    changes: CHANGES,
    sources: SOURCES,
    candidateSymbols: [],
    failureOutput: FAILURE,
  });
  assert.ok(prompt.includes('TS2554'), 'the current failure must reach the model');
  assert.ok(
    !prompt.toLowerCase().includes('previous attempt'),
    'no attempt has been made yet, so none may be claimed',
  );
});

test('the prompt carries every prior attempt, not just the most recent', () => {
  // With only the last attempt in context, attempt 3 cannot see what attempt 1
  // tried and is free to re-propose it. A bounded retry budget then gets spent
  // oscillating between two wrong fixes instead of exploring a third.
  const prompt = buildUserPrompt({
    finding: FINDING,
    changes: CHANGES,
    sources: SOURCES,
    candidateSymbols: [],
    previousAttempts: [
      { edits: [edit('FIRST_TRY', 'a')], errors: 'still broken' },
      { edits: [edit('SECOND_TRY', 'b')], errors: 'still broken' },
    ],
  });
  assert.ok(prompt.includes('FIRST_TRY'), 'the earliest attempt must remain visible');
  assert.ok(prompt.includes('SECOND_TRY'), 'the most recent attempt must remain visible');
});
