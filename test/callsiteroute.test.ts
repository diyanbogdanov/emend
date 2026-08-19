import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { locateCallSites, resolverFor, walkDir } from '../src/callsites.ts';
import type { ApiSurface } from '../src/types.ts';

test('TypeScript claims the extensions it can type-check', () => {
  assert.equal(resolverFor('src/index.ts')?.id, 'typescript');
  assert.equal(resolverFor('src/index.tsx')?.id, 'typescript');
  assert.equal(resolverFor('src/index.mjs')?.id, 'typescript');
});

test('a file no resolver claims is undefined, not zero call sites', () => {
  // Zero call sites renders as "not imported from this repository's source".
  // For a file nobody parsed, that sentence is false.
  // Not `.py`: Task 9 registered a Python resolver (see pythoncallsites.test.ts),
  // so `.py` now claims and is no longer an example of "nothing claims this
  // file". `.rs` still is, on every extension.
  assert.equal(resolverFor('src/lib.rs'), undefined);
});

// ---------------------------------------------------------------------------
// locateCallSites — the actual scan-pipeline entry point into the seam above.
//
// Registering a resolver in `RESOLVERS` is not enough on its own: something
// has to dispatch through `resolverForEcosystem` and await `find`. Before
// this test existed, nothing in the test suite ran the real call-site stage
// against a Python fixture at all — `analyze.ts` called the TypeScript-only
// `findCallSites` directly, so every Python package's call sites silently
// went unlocated. This proves the dispatch itself, against real files on
// disk, not just that the resolver is registered.
// ---------------------------------------------------------------------------

function minimalSurface(pkg: string): ApiSurface {
  return { pkg, version: '1.0.0', symbols: {}, byTypeMember: {}, aliases: {}, entry: null };
}

function tempRepo(files: Record<string, string>): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-locatecallsites-'));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), body);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a Python package routes to the Python resolver and its call site is found', async () => {
  const repo = tempRepo({
    'app.py': 'from requests import send\n\nsend("https://example.com")\n',
  });
  try {
    const surfaces = new Map([['requests', minimalSurface('requests')]]);
    const wanted = new Map([['requests', new Set(['send'])]]);
    const ecosystemOf = new Map([['requests', 'PyPI']]);

    const index = await locateCallSites(repo.dir, surfaces, wanted, ecosystemOf);

    const sites = index.byPackage.get('requests')?.get('send');
    assert.equal(sites?.length, 1);
    assert.equal(sites?.[0]?.file, 'app.py');
    assert.equal(sites?.[0]?.line, 3);
  } finally {
    repo.cleanup();
  }
});

test('npm and PyPI packages in the same scan are each found by their own resolver, and the index merges honestly', async () => {
  const repo = tempRepo({
    'app.py': 'from requests import send\n\nsend("https://example.com")\n',
    'src/index.ts': "import { widget } from 'acme-sdk';\n\nwidget();\n",
  });
  try {
    const surfaces = new Map([
      ['requests', minimalSurface('requests')],
      ['acme-sdk', minimalSurface('acme-sdk')],
    ]);
    const wanted = new Map([
      ['requests', new Set(['send'])],
      ['acme-sdk', new Set(['widget'])],
    ]);
    const ecosystemOf = new Map([
      ['requests', 'PyPI'],
      ['acme-sdk', 'npm'],
    ]);

    const index = await locateCallSites(repo.dir, surfaces, wanted, ecosystemOf);

    assert.equal(index.byPackage.get('requests')?.get('send')?.length, 1);
    assert.equal(index.byPackage.get('acme-sdk')?.get('widget')?.length, 1);
    // One resolver's file count must not overwrite the other's — the pipeline
    // reports `filesAnalyzed` as evidence of how much was actually read.
    assert.equal(index.filesAnalyzed, 2);
  } finally {
    repo.cleanup();
  }
});

test('a package whose ecosystem no resolver claims is named in a warning, not silently dropped', async () => {
  const repo = tempRepo({ 'app.py': 'x = 1\n' });
  try {
    const surfaces = new Map([['some-crate', minimalSurface('some-crate')]]);
    const wanted = new Map([['some-crate', new Set(['run'])]]);
    const ecosystemOf = new Map([['some-crate', 'crates.io']]);

    const index = await locateCallSites(repo.dir, surfaces, wanted, ecosystemOf);

    // Not absent from `byPackage`: an empty bucket, so a caller counting
    // impacting changes against it gets "unlocated", never a false "clean".
    assert.deepEqual(index.byPackage.get('some-crate'), new Map());
    assert.ok(index.warnings.some((w) => w.includes('crates.io') && w.includes('some-crate')));
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------
// walkDir's own skip set. Stronger than `isVendored` (python/callsites.ts,
// see pythoncallsites.test.ts): this shared, language-agnostic walk never
// descends into these directories at all, for every caller — the TypeScript
// program builder above and analyze.ts's generic source-file collection —
// not just Python's call-site search, which still visits a vendored
// directory's files and filters them out one by one.
// ---------------------------------------------------------------------------

function relFiles(dir: string, found: string[]): string[] {
  return found.map((f) => path.relative(dir, f).split(path.sep).join('/')).sort();
}

test('walkDir never descends into a repository\'s own vendored Python environment', () => {
  const repo = tempRepo({
    '.venv/lib/pkg/mod.py': 'x = 1\n',
    'venv/lib/pkg/mod.py': 'x = 1\n',
    '__pycache__/mod.py': 'x = 1\n',
    'site-packages/pkg/mod.py': 'x = 1\n',
    '.tox/py312/lib/mod.py': 'x = 1\n',
    '.nox/py312/lib/mod.py': 'x = 1\n',
    'envs/myenv/lib/mod.py': 'x = 1\n',
    'src/app.py': 'x = 1\n',
  });
  try {
    assert.deepEqual(relFiles(repo.dir, walkDir(repo.dir, ['.py'])), ['src/app.py']);
  } finally {
    repo.cleanup();
  }
});

test('walkDir only skips a bare env/ directory when pyvenv.cfg marks it a virtual environment', () => {
  // `env` is a plausible real source directory (`src/env/config.py`), unlike
  // every other name above, so a name match alone is not enough — the same
  // false-skip risk python/callsites.ts's VENDORED_DIR guards against.
  const withMarker = tempRepo({
    'env/pyvenv.cfg': 'home = /usr/bin\n',
    'env/lib/mod.py': 'x = 1\n',
    'src/app.py': 'x = 1\n',
  });
  try {
    assert.deepEqual(relFiles(withMarker.dir, walkDir(withMarker.dir, ['.py'])), ['src/app.py']);
  } finally {
    withMarker.cleanup();
  }

  const withoutMarker = tempRepo({ 'env/app.py': 'x = 1\n' });
  try {
    assert.deepEqual(relFiles(withoutMarker.dir, walkDir(withoutMarker.dir, ['.py'])), ['env/app.py']);
  } finally {
    withoutMarker.cleanup();
  }
});
