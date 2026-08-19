import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { analyseImpact, analyzerFor, renderImpact, typescriptAnalyzer } from '../src/impact.ts';

function repo(files: Record<string, string>): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-impact-'));
  writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', strict: true } }),
  );
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), body);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const HELPERS = `export function formatPrice(n: number): string {
  return n.toFixed(2);
}
export function unused(): number {
  return 1;
}
function local(): number {
  return 2;
}
export function usesLocal(): number {
  return local();
}
`;

// ---------------------------------------------------------------------------
// What changing a symbol would cost
// ---------------------------------------------------------------------------

test('a symbol other files depend on reports where they are', async () => {
  // The question the agent could not previously answer: if I change the shape of
  // this function to satisfy a migration, what else breaks? Today it finds out
  // by the build going red and retrying blind.
  const r = repo({
    'src/helpers.ts': HELPERS,
    'src/cart.ts': `import { formatPrice } from './helpers.ts';\nexport const a = (): string => formatPrice(1);\n`,
    'src/invoice.ts': `import { formatPrice } from './helpers.ts';\nexport const b = (): string => formatPrice(2);\n`,
  });
  try {
    const impacts = await analyseImpact(r.dir, ['src/helpers.ts']);
    const priced = impacts.find((i) => i.name === 'formatPrice');
    assert.equal(priced?.external.length, 2);
    assert.deepEqual(
      priced?.external.map((s) => s.file).sort(),
      ['src/cart.ts', 'src/invoice.ts'],
    );
  } finally {
    r.cleanup();
  }
});

test('a symbol nothing outside its file uses has no external cost', async () => {
  // The distinction that matters for a decision: `local` can be reshaped freely,
  // `formatPrice` cannot.
  const r = repo({ 'src/helpers.ts': HELPERS });
  try {
    const impacts = await analyseImpact(r.dir, ['src/helpers.ts']);
    assert.equal(impacts.find((i) => i.name === 'local')?.external.length, 0);
    assert.equal(impacts.find((i) => i.name === 'unused')?.external.length, 0);
  } finally {
    r.cleanup();
  }
});

test('the import line is not counted as a second dependent', async () => {
  // `import { formatPrice }` survives any change to what formatPrice takes or
  // returns; only the call below it breaks. Counting the binding would report
  // every importing file twice and inflate the number the agent is weighing.
  const r = repo({
    'src/helpers.ts': HELPERS,
    'src/cart.ts': `import { formatPrice } from './helpers.ts';\nexport const a = (): string => formatPrice(1);\n`,
  });
  try {
    const impacts = await analyseImpact(r.dir, ['src/helpers.ts']);
    const priced = impacts.find((i) => i.name === 'formatPrice');
    assert.equal(priced?.external.length, 1);
    assert.equal(priced?.external[0]?.line, 2, 'the call, not the import on line 1');
  } finally {
    r.cleanup();
  }
});

test('a re-export is followed to the code that actually calls through it', async () => {
  // The reason this is a type checker and not a grep for the name: `formatPrice`
  // never appears in report.ts as an import from helpers.ts, and the call there
  // still breaks.
  const r = repo({
    'src/helpers.ts': HELPERS,
    'src/index.ts': `export { formatPrice } from './helpers.ts';\n`,
    'src/report.ts': `import { formatPrice } from './index.ts';\nexport const r = (): string => formatPrice(3);\n`,
  });
  try {
    const impacts = await analyseImpact(r.dir, ['src/helpers.ts']);
    const priced = impacts.find((i) => i.name === 'formatPrice');
    assert.deepEqual(priced?.external.map((s) => s.file), ['src/report.ts']);
  } finally {
    r.cleanup();
  }
});

test('a repository that cannot be built yields nothing rather than a guess', async () => {
  // No tsconfig, no program, no references. Reporting "nothing depends on this"
  // when nothing was analysed would be the most dangerous possible answer here.
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-noimpact-'));
  try {
    assert.deepEqual(await analyseImpact(dir, ['nope.ts']), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The seam a second language plugs into
// ---------------------------------------------------------------------------

test('the analyzer is chosen by the file, not assumed to be TypeScript', () => {
  // Python and Rust each have their own answer to "who references this", and
  // each will be its own analyzer. Nothing above this line may assume otherwise.
  assert.equal(analyzerFor('src/app.ts')?.id, 'typescript');
  assert.equal(analyzerFor('src/app.tsx')?.id, 'typescript');
  assert.equal(analyzerFor('src/app.mjs')?.id, 'typescript');
  assert.equal(analyzerFor('main.py'), undefined);
  assert.equal(analyzerFor('Dockerfile'), undefined);
});

test('the TypeScript analyzer says which files it can answer for', () => {
  const ts = typescriptAnalyzer();
  assert.equal(ts.handles('a.ts'), true);
  assert.equal(ts.handles('a.py'), false);
});

// ---------------------------------------------------------------------------
// What the agent is told
// ---------------------------------------------------------------------------

test('only symbols with external users are worth the prompt’s budget', () => {
  const rendered = renderImpact([
    { name: 'formatPrice', declaredIn: 'src/helpers.ts', external: [
      { file: 'src/cart.ts', line: 2, column: 1, text: 'formatPrice(1)' },
      { file: 'src/invoice.ts', line: 2, column: 1, text: 'formatPrice(2)' },
    ] },
    { name: 'local', declaredIn: 'src/helpers.ts', external: [] },
  ]);
  assert.match(rendered, /formatPrice/);
  assert.match(rendered, /2 place/);
  assert.ok(!rendered.includes('local'), 'a symbol nothing uses is not worth a line');
});

test('nothing to say produces nothing, rather than a heading with no content', () => {
  assert.equal(renderImpact([]), '');
  assert.equal(renderImpact([{ name: 'x', declaredIn: 'a.ts', external: [] }]), '');
});

test('a widely-used symbol is capped in the listing but honest about the total', () => {
  // A symbol with two hundred callers must not consume the prompt, and must not
  // be reported as having as many as happen to fit.
  const many = Array.from({ length: 40 }, (_, i) => ({
    file: `src/f${i}.ts`,
    line: 1,
    column: 1,
    text: 'x()',
  }));
  const rendered = renderImpact([{ name: 'wide', declaredIn: 'src/a.ts', external: many }]);
  assert.match(rendered, /40 place/);
  assert.ok(rendered.split('\n').length < 20, 'the listing itself stays short');
});

test('two references on one line are one place to fix', async () => {
  // Measured on this repository: `PROVENANCE_RANK[b.provenance] -
  // PROVENANCE_RANK[a.provenance]` is one line and one edit, and was reported
  // twice — spending two of the five listing slots on a duplicate and
  // overstating the reach by one. The actionable unit is the line.
  const r = repo({
    'src/helpers.ts': HELPERS,
    'src/cart.ts':
      `import { formatPrice } from './helpers.ts';\n` +
      `export const pair = (): string => formatPrice(1) + formatPrice(2);\n`,
  });
  try {
    const impacts = await analyseImpact(r.dir, ['src/helpers.ts']);
    const priced = impacts.find((i) => i.name === 'formatPrice');
    assert.equal(priced?.external.length, 1);
    assert.equal(priced?.external[0]?.line, 2);
  } finally {
    r.cleanup();
  }
});

test('the limit of the method travels with its results', () => {
  // `obj[name]()`, or a class named by a string in a container, resolves to
  // nothing — so a symbol with no listed dependents may still have callers. The
  // caveat sits next to the data rather than only in a numbered rule far above
  // it, because that is where it will be read.
  const rendered = renderImpact([
    {
      name: 'formatPrice',
      declaredIn: 'src/helpers.ts',
      external: [{ file: 'src/cart.ts', line: 2, column: 1, text: 'formatPrice(1)' }],
    },
  ]);
  assert.match(rendered, /none were found/i, 'absence must not read as proof of absence');
  assert.match(rendered, /reflection|dynamic/i);
});
