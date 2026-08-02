import test from 'node:test';
import assert from 'node:assert/strict';
import { findRename, planFinding } from '../src/plan.ts';
import type { ApiSymbol, Finding, SurfaceChange } from '../src/types.ts';

function symbols(entries: Array<[string, string, Partial<ApiSymbol>?]>): Record<string, ApiSymbol> {
  return Object.fromEntries(
    entries.map(([path, signature, extra]) => [
      path,
      { path, kind: 'property', signature, deprecated: false, optional: false, ...extra },
    ]),
  );
}

const removed: SurfaceChange = {
  path: 'ZodError.errors',
  kind: 'removed',
  severity: 'breaking',
  confidence: 'high',
  before: 'ZodIssue[]',
  after: null,
};

test('finds a replacement that already existed in the old version', () => {
  // Responsible deprecation adds the new name first, deprecates the old, then
  // removes it a release later. By the time the removal lands the replacement is
  // not "new" — a rename detector that only searches newly-added symbols misses
  // the entire well-behaved case. zod's `.errors` -> `.issues` is exactly this.
  const rename = findRename(
    removed,
    symbols([
      ['ZodError.issues', '$ZodIssue[]'],
      ['ZodError.message', 'string'],
    ]),
  );
  assert.equal(rename?.to, 'ZodError.issues');
});

test('refuses to guess when two candidates match equally well', () => {
  // A wrong automated edit costs far more trust than an honest "cannot fix".
  const rename = findRename(
    removed,
    symbols([
      ['ZodError.issues', 'ZodIssue[]'],
      ['ZodError.problems', 'ZodIssue[]'],
    ]),
  );
  assert.equal(rename, null);
});

test('never proposes a replacement that is itself deprecated', () => {
  const rename = findRename(
    removed,
    symbols([['ZodError.issues', 'ZodIssue[]', { deprecated: true }]]),
  );
  assert.equal(rename, null, 'migrating onto a deprecated symbol is a dead end');
});

test('does not move a member into a different container', () => {
  // Cross-container moves are a different, riskier transformation than a rename.
  const rename = findRename(removed, symbols([['SomethingElse.issues', 'ZodIssue[]']]));
  assert.equal(rename, null);
});

const finding: Finding = {
  id: 'test1',
  pkg: 'zod',
  fromVersion: '3.22.4',
  toVersion: '4.4.3',
  change: removed,
  confidence: 'high',
  sites: [
    { file: 'src/a.ts', line: 41, column: 23, text: 'result.error.errors.map(...)', via: 'type' },
    { file: 'src/b.ts', line: 7, column: 1, text: 'z.something', via: 'import' },
  ],
};

test('plans an edit only at sites that point to the member identifier', () => {
  // A `type`-resolved site points at the member token itself, which is what a
  // rename must replace. An `import`-resolved site points at the head of the
  // access chain (`z` in `z.string().min()`), so editing at that column would
  // corrupt an unrelated token.
  const plan = planFinding(finding, symbols([['ZodError.issues', '$ZodIssue[]']]));
  assert.equal(plan?.edits.length, 1);
  assert.equal(plan?.edits[0]?.file, 'src/a.ts');
  assert.equal(plan?.edits[0]?.find, 'errors');
  assert.equal(plan?.edits[0]?.replace, 'issues');
});

test('produces no plan at all when no replacement is derivable', () => {
  const plan = planFinding(finding, symbols([['ZodError.unrelated', 'number']]));
  assert.equal(plan, null);
});
