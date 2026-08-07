import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  importsSymbolFrom,
  deprecationStillPresent,
  remainingDeprecations,
  describeDeprecationGaps,
} from '../src/quality.ts';
import { REVIEW_SYSTEM_PROMPT } from '../src/llm/agent.ts';
import type { Finding } from '../src/types.ts';

function deprecationFinding(files: string[]): Finding {
  return {
    id: '5f6f9004bebe',
    detector: 'npm-surface',
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

// ---------------------------------------------------------------------------
// deprecationStillPresent — the gate's question, not the report's
//
// `remainingDeprecations` deliberately looks only at imports, because a false
// "still deprecated" shown to a reviewer is indistinguishable from a real one.
// The evidence gate asks the same question for the opposite purpose: a false
// positive there only *permits* an edit that verification still judges, while a
// false negative withholds the migration the finding asked for. So members are
// resolved here and not there, and the asymmetry is the point.
// ---------------------------------------------------------------------------

test('a deprecated member reached through a call chain counts as still present', () => {
  // zod 4 deprecates ZodString.email in favour of the top-level z.email. It is
  // never a named import, so the import-scoped check cannot see it, and the gate
  // would withhold the very edit that performs the migration.
  const source = "import { z } from 'zod';\nconst S = z.object({ id: z.string().uuid() });";
  assert.equal(deprecationStillPresent('ZodString.uuid', 'zod', source), true);
});

test('a member migrated to a same-named top-level call still reads as present', () => {
  // Known limitation, and biased this way on purpose. zod's deprecated
  // `z.string().uuid()` and its replacement `z.uuid()` both contain `.uuid`;
  // separating them means resolving what the call sits on, which is the type
  // checker's job and not a regex's.
  //
  // So the site keeps reading as outstanding, which *permits* edits there rather
  // than withholding them. Permitting is the safe direction: verification still
  // judges whatever the model writes, whereas withholding cancels the migration
  // the finding exists to request. Exact resolution needs the checker, and the
  // eval harness is what should decide whether that is worth its cost.
  const source = "import { z } from 'zod';\nconst S = z.object({ id: z.uuid() });";
  assert.equal(deprecationStillPresent('ZodString.uuid', 'zod', source), true);
});

test('a bare identifier is not mistaken for a member access', () => {
  // `uuid` the variable, `uuid` the package, `uuid` in prose. Only a property
  // access is evidence that the deprecated member is still being called.
  const source = "import { v4 as uuid } from 'uuid';\nconst id = uuid();";
  assert.equal(deprecationStillPresent('ZodString.uuid', 'zod', source), false);
});

test('a top-level deprecated export still resolves by import, not by member access', () => {
  // `Cell` has no container, so the import check remains the authority for it —
  // `.Cell` would not appear even when it is very much still in use.
  const source = "import { BarChart, Cell } from 'recharts';\nexport const c = <Cell />;";
  assert.equal(deprecationStillPresent('Cell', 'recharts', source), true);
  assert.equal(
    deprecationStillPresent('Cell', 'recharts', "import { BarChart } from 'recharts';"),
    false,
  );
});

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

test('the review prompt says what to do with a comment the migration made false', () => {
  // Measured: on every zod run the review pass rewrote the file's doc comment,
  // which had said "Written against zod 3.x", into a duplicate of the line
  // directly above it:
  //
  //     /**
  //      * Validation schemas for the checkout service.
  //      *
  //      * Validation schemas for the checkout service.
  //      */
  //
  // Updating it was right — the comment had become untrue, and a migration that
  // leaves a false comment behind is incomplete. Rule 6 covers code the
  // migration did not touch and says nothing about comments, so the pass had no
  // guidance and produced a careless edit six runs out of six.
  assert.match(REVIEW_SYSTEM_PROMPT, /comment/i);
  // Specifically: the replacement has to stand on its own, which is the part
  // that failed.
  assert.match(REVIEW_SYSTEM_PROMPT, /repeat|duplicat/i);
});
