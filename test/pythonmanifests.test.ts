import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readPythonManifest } from '../src/python/manifests.ts';

const fixture = (name: string): string =>
  readFileSync(path.join(import.meta.dirname, 'fixtures', 'python', name), 'utf8');

// Every fixture in test/fixtures/python/ is a real, unmodified file fetched
// from a real repository — never hand-written to fit these parsers' regexes
// (see src/python/manifests.ts's module doc for why that distinction matters
// for a line-matching parser). Provenance, as fetched:
//
//   uv.lock       astral-sh/uv-docker-example @ 3c23b2c (main), the maker of
//                 uv's own official Docker example — 42 packages.
//   poetry.lock   python-poetry/poetry @ 500a313 (master), Poetry dogfooding
//                 itself to manage its own dependencies — 69 packages.
//   pdm.lock      pdm-project/pdm-backend @ f1a4267 (main), PDM's own build
//                 backend dogfooding PDM — 58 packages.
//   Pipfile.lock  pypa/pipenv @ 96e6b19 (main), Pipenv dogfooding itself —
//                 10 default + 100 develop packages.
//
// All four fetched 2026-08-19 from raw.githubusercontent.com. requirements.txt
// has no fixture file: its tests below use inline text, matching how simple
// and unambiguous the line-oriented format already is — the risk this task
// exists to catch is TOML block-boundary tracking against real formatting,
// which requirements.txt has none of.

test('uv.lock yields resolved versions', () => {
  const parsed = readPythonManifest('uv.lock', fixture('uv.lock'));
  assert.equal(parsed.kind, 'uv.lock');
  assert.equal(parsed.resolved, true);
  // Confirmed by reading test/fixtures/python/uv.lock directly: `requests` is
  // not a dependency of this particular project, `httpx` is, at this version.
  assert.equal(parsed.versions.get('httpx'), '0.28.1');
  // A lockfile has no notion of "the range that produced this resolution" —
  // that lives in pyproject.toml, which this module does not read — so
  // `declared` stays empty rather than fabricating one.
  assert.equal(parsed.declared.size, 0);
});

test('poetry.lock yields resolved versions', () => {
  const parsed = readPythonManifest('poetry.lock', fixture('poetry.lock'));
  assert.equal(parsed.kind, 'poetry.lock');
  assert.equal(parsed.resolved, true);
  // Confirmed by reading test/fixtures/python/poetry.lock directly.
  assert.equal(parsed.versions.get('requests'), '2.31.0');
});

test('pdm.lock yields resolved versions', () => {
  const parsed = readPythonManifest('pdm.lock', fixture('pdm.lock'));
  assert.equal(parsed.kind, 'pdm.lock');
  assert.equal(parsed.resolved, true);
  // Confirmed by reading test/fixtures/python/pdm.lock directly.
  assert.equal(parsed.versions.get('requests'), '2.32.5');
});

test('Pipfile.lock yields resolved versions', () => {
  const parsed = readPythonManifest('Pipfile.lock', fixture('Pipfile.lock'));
  assert.equal(parsed.kind, 'Pipfile.lock');
  assert.equal(parsed.resolved, true);
  // Confirmed by reading test/fixtures/python/Pipfile.lock directly: `requests`
  // is pinned in the "develop" group there, not "default" — proving both
  // groups are actually read, not just the first one tried.
  assert.equal(parsed.versions.get('requests'), '2.34.2');
});

test('requirements.txt yields ranges, never presented as resolutions', () => {
  // The distinction `InstalledDependency.source` exists for: a range "may name a
  // version that was never published — callers must not present it as a fact read
  // from the repository."
  const parsed = readPythonManifest('requirements.txt', 'requests>=2.31.0\nurllib3~=2.0\n');
  assert.equal(parsed.resolved, false);
  assert.equal(parsed.declared.get('requests'), '>=2.31.0');
  assert.equal(parsed.versions.size, 0);
});

test('a comment, a blank line and an editable install are all skipped', () => {
  // Real requirements.txt files are full of these. Treating `-e .` as a package
  // named `-e` would put a nonsense entry into a vulnerability query.
  const parsed = readPythonManifest(
    'requirements.txt',
    '# pinned for CI\n\n-e .\n-r other.txt\nrequests==2.31.0\n',
  );
  assert.deepEqual([...parsed.declared.keys()], ['requests']);
});

test('a bare package name with no specifier is still declared, with an empty range', () => {
  // Found in the wild while validating this parser: ansible/requirements.txt
  // lists `cryptography` and `packaging` with no version constraint at all.
  // Dropping unpinned lines would under-report a real repository's dependencies.
  const parsed = readPythonManifest('requirements.txt', 'cryptography\n');
  assert.equal(parsed.declared.get('cryptography'), '');
});

test('an inline trailing comment does not leak into the specifier', () => {
  // Found in the wild: ansible/requirements.txt writes
  // `jinja2 >= 3.1.0  # Jinja2 native macro support fixed in 3.1.0`. A parser
  // that only strips full-line comments would record the specifier as
  // `>= 3.1.0  # Jinja2 native macro support fixed in 3.1.0`.
  const parsed = readPythonManifest(
    'requirements.txt',
    'jinja2 >= 3.1.0  # Jinja2 native macro support fixed in 3.1.0\n',
  );
  assert.equal(parsed.declared.get('jinja2'), '>= 3.1.0');
});

test('an unrecognised shape reports unsupported rather than nothing', () => {
  // A parser that silently returns nothing makes a repository look like it has no
  // dependencies, which the vulnerability detector reports as nothing to fix.
  const parsed = readPythonManifest('poetry.lock', 'this is not a lockfile at all\n');
  assert.equal(parsed.versions.size, 0);
  assert.equal(parsed.unsupported, 'poetry.lock');
});

test('an empty lockfile is genuinely empty, not unsupported', () => {
  // The distinction the module doc draws: "content but nothing was read" is
  // unsupported, an absent file's worth of content is just empty. Collapsing
  // the two would flag a freshly-created, dependency-free project as broken.
  const parsed = readPythonManifest('uv.lock', '');
  assert.equal(parsed.versions.size, 0);
  assert.equal(parsed.unsupported, null);
});

test('Pipfile.lock that is not valid JSON reports unsupported', () => {
  // Exercises a different failure path than the TOML lockfiles' — JSON.parse
  // throwing — which is worth its own case since it is different code.
  const parsed = readPythonManifest('Pipfile.lock', '{not valid json');
  assert.equal(parsed.versions.size, 0);
  assert.equal(parsed.unsupported, 'Pipfile.lock');
});

test('a subtable that writes its own name/version pair is not read as a package', () => {
  // Synthetic, not a real fixture — none of the four real lockfiles checked
  // here (see the provenance comment above) ever write a bare `name =` inside
  // a per-package subtable; their dependency lists use inline tables
  // (`{ name = "x" }`) or arbitrary keys instead, both of which the anchored
  // regex in parsePackageBlocks already ignores. This construction exists to
  // prove the second line of defence for real: `readPythonManifest` tracks
  // whether it is inside a genuine `[[package]]` block rather than merely
  // clearing a "pending name" on any table header, because the weaker rule
  // does *not* stop this case — a subtable's own name/version pair still
  // matches the same regex a real package's does. Traced by hand and checked
  // against both variants before writing this parser.
  const parsed = readPythonManifest(
    'poetry.lock',
    [
      '[[package]]',
      'name = "alpha"',
      'version = "1.0.0"',
      '',
      '[package.dependencies]',
      'name = "not-a-real-package"',
      'version = "9.9.9"',
      '',
      '[[package]]',
      'name = "beta"',
      'version = "2.0.0"',
      '',
    ].join('\n'),
  );
  assert.deepEqual(
    [...parsed.versions.entries()].sort(),
    [
      ['alpha', '1.0.0'],
      ['beta', '2.0.0'],
    ],
  );
});
