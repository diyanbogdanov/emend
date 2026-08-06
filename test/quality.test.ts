import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  importsSymbolFrom,
  remainingDeprecations,
  describeDeprecationGaps,
} from '../src/quality.ts';
import { REVIEW_SYSTEM_PROMPT } from '../src/llm/agent.ts';
import type { Finding } from '../src/types.ts';

function deprecationFinding(files: string[]): Finding {
  return {
    id: '5f6f9004bebe',
    pkg: 'recharts',
    fromVersion: '2.15.4',
    toVersion: '3.10.1',
    change: {
      path: 'Cell',
      kind: 'deprecated',
      severity: 'deprecation',
      confidence: 'high',
      before: 'Cell: FunctionComponent<SVGProps<SVGElement>>',
      after: 'Cell: FunctionComponent<Props>',
    },
    sites: files.map((file) => ({
      file,
      line: 1,
      column: 1,
      text: '<Cell />',
      via: 'import' as const,
    })),
    confidence: 'high',
  };
}

test('a migration that leaves the deprecated symbol imported is reported', () => {
  // The case that shipped: Emend reported `Cell` as deprecated, titled its
  // commit "migrate `Cell`", and removed no use of `Cell`. Every check passed,
  // because deprecated code compiles and its tests pass. Verification cannot
  // catch this, so it has to be measured.
  const after = `import { BarChart, Bar, Tooltip, Cell } from 'recharts'
export function Chart() { return <Bar>{d.map((x) => <Cell key={x.id} fill={x.c} />)}</Bar> }`;
  assert.equal(importsSymbolFrom(after, 'Cell', 'recharts'), true);
});

test('a finished migration is not reported', () => {
  const fixed = `import { BarChart, Bar, Tooltip } from 'recharts'
export function Chart() { return <Bar /> }`;
  assert.equal(importsSymbolFrom(fixed, 'Cell', 'recharts'), false);
});

test('a same-named symbol from a different package is not a false positive', () => {
  // This repository imports `Cell` from a table library in unrelated files. A
  // bare text search flags those as unfinished migrations, and a false "still
  // deprecated" is indistinguishable from a real one to whoever reads the PR.
  const other = `import { Cell, Row } from '@tanstack/react-table'
import { BarChart } from 'recharts'`;
  assert.equal(importsSymbolFrom(other, 'Cell', 'recharts'), false);
  assert.equal(importsSymbolFrom(other, 'Cell', '@tanstack/react-table'), true);
});

test('aliased, type-only and multi-line imports still count as usage', () => {
  // `import { Cell as C }` still uses Cell; renaming it locally changes nothing
  // about the dependency on a deprecated export.
  assert.equal(importsSymbolFrom(`import { Cell as C } from 'recharts'`, 'Cell', 'recharts'), true);
  assert.equal(importsSymbolFrom(`import type { Cell } from 'recharts'`, 'Cell', 'recharts'), true);
  assert.equal(
    importsSymbolFrom("import {\n  Bar,\n  Cell,\n} from 'recharts'", 'Cell', 'recharts'),
    true,
  );
  // A subpath of the same package counts; a local file that merely starts the
  // same way does not.
  assert.equal(importsSymbolFrom(`import { Cell } from 'recharts/es6'`, 'Cell', 'recharts'), true);
  assert.equal(importsSymbolFrom(`import { Cell } from './recharts-shim'`, 'Cell', 'recharts'), false);
});

test('only files the finding named are examined', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-quality-'));
  try {
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'src/a.tsx'), `import { Cell } from 'recharts'\n`);
    writeFileSync(path.join(dir, 'src/b.tsx'), `import { Bar } from 'recharts'\n`);
    // Not in the finding's sites: the scan already decided where the symbol is
    // used, and widening the search re-introduces the false positives above.
    writeFileSync(path.join(dir, 'src/unrelated.tsx'), `import { Cell } from 'recharts'\n`);

    const gaps = await remainingDeprecations([deprecationFinding(['src/a.tsx', 'src/b.tsx'])], dir);
    assert.equal(gaps.length, 1);
    assert.deepEqual(gaps[0]?.files, ['src/a.tsx']);
    assert.match(describeDeprecationGaps(gaps), /`Cell` is deprecated in recharts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fully finished deprecation produces no gap at all', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-quality-'));
  try {
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'src/a.tsx'), `import { Bar } from 'recharts'\n`);
    const gaps = await remainingDeprecations([deprecationFinding(['src/a.tsx'])], dir);
    assert.deepEqual(gaps, []);
    assert.equal(describeDeprecationGaps(gaps), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file the migration deleted is not a gap', async () => {
  // Removing the file that used the symbol is a legitimate way to finish.
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-quality-'));
  try {
    const gaps = await remainingDeprecations([deprecationFinding(['src/gone.tsx'])], dir);
    assert.deepEqual(gaps, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the review prompt demands the deprecation be finished before anything else', () => {
  assert.match(REVIEW_SYSTEM_PROMPT, /Finish the migration first/);
  assert.match(REVIEW_SYSTEM_PROMPT, /has not done what it said/);
  // The two human-review findings that motivated this pass, neither of which
  // could fail verification.
  assert.match(REVIEW_SYSTEM_PROMPT, /repeated at three or more call sites is a missing helper/);
  assert.match(REVIEW_SYSTEM_PROMPT, /renders a real string as "0"/);
  // And the licence to decline, so the pass does not invent work to look busy.
  assert.match(REVIEW_SYSTEM_PROMPT, /empty "edits" array/);
});
