import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readLockfile } from '../src/lockfile.ts';

const fixtureDir = (name: string): string =>
  path.join(import.meta.dirname, 'fixtures', 'lockfiles', name);
const read = (fixture: string) => readLockfile(fixtureDir(fixture));

// Every fixture under test/fixtures/lockfiles/ is the real, unmodified output
// of a real package manager run against the public npm registry (or, for
// bun.lockb, fetched unmodified from a real repository) — never hand-written
// to fit these parsers' line-matching regexes. See src/lockfile.ts's module
// doc for why that distinction matters for a parser that reads facts out of
// raw lines rather than through a real YAML/JSON-schema-aware library.
// Provenance, exactly as produced:
//
//   npm/package-lock.json   `npm install --ignore-scripts` (npm 11.17.0,
//                           Node 24.0.2) against the public registry, for a
//                           package.json depending on chalk@2.4.2 directly
//                           and chalk@4.1.2 under the npm alias "chalk-new"
//                           (`"chalk-new": "npm:chalk@4.1.2"`). Chosen
//                           because chalk@2 and chalk@4 need incompatible
//                           ansi-styles/has-flag ranges, which is what makes
//                           npm's own resolver genuinely nest one copy of
//                           each under node_modules/chalk-new rather than
//                           hoisting it — a real instance of the "two
//                           packages need incompatible versions of a third"
//                           case this module's own doc names, not a
//                           contrived one. Generated 2026-08-19.
//   pnpm/pnpm-lock.yaml     `pnpm install --ignore-scripts` (pnpm 10.24.0)
//                           against the public registry, for a package.json
//                           depending on zod@3.25.76 and
//                           @types/node@22.15.30 (which itself pulls in
//                           undici-types). Generated 2026-08-19.
//   yarn/yarn.lock          `yarn install --ignore-scripts` (yarn 1.22.22,
//                           "classic", run via corepack) against the public
//                           registry, for the same package.json as the pnpm
//                           fixture above. Generated 2026-08-19.
//   bun/bun.lock            `bun install --ignore-scripts` (bun 1.3.12)
//                           against the public registry, for the same
//                           package.json again. Bun 1.3.12 writes the text
//                           `bun.lock` format by default; no flag or
//                           environment variable this session tried
//                           (--save-text-lockfile is the only related flag
//                           `bun install --help` lists, and it is already
//                           the default) produced the legacy binary format
//                           locally — see bun-lockb below. Generated
//                           2026-08-19.
//   bun-lockb/bun.lockb     Not generated locally, for the reason above.
//                           Fetched unmodified instead from oven-sh/bun's
//                           own repository at tag bun-v1.1.38 — Bun
//                           dogfooding its own legacy binary lockfile format
//                           for its own JS tooling, from before the project
//                           switched its default to the text format. Real
//                           binary content (starts with the
//                           `#!/usr/bin/env bun\nbun-lockfile-format-v0`
//                           header Bun itself writes), fetched 2026-08-19
//                           from raw.githubusercontent.com. readLockfile
//                           never parses this file's content — the
//                           `unsupported` path below is a presence check by
//                           filename only — so genuineness here is about
//                           honesty of provenance, not about anything the
//                           parser reads.
//
// pnpm, yarn and bun deliberately share one package.json (zod +
// @types/node) so their fixtures are easy to compare by eye; npm's is its
// own scenario because the nested-duplicate case needed a real conflict.

test('package-lock.json: real npm output resolves to the right versions, tree and kind', async () => {
  const result = await read('npm');
  assert.equal(result.kind, 'package-lock.json');
  assert.equal(result.unsupported, null);

  // Confirmed by reading test/fixtures/lockfiles/npm/package-lock.json
  // directly: eight distinct top-level names, each with the version npm
  // actually resolved. "chalk-new" is the install-path/alias name; the
  // package it resolves is really named "chalk" (asserted in the tree check
  // below), but `versions` is keyed by top-level install path on purpose —
  // see topLevelName's doc — so the alias name is the correct key here.
  assert.deepEqual(
    [...result.versions.entries()].sort(),
    [
      ['ansi-styles', '3.2.1'],
      ['chalk', '2.4.2'],
      ['chalk-new', '4.1.2'],
      ['color-convert', '1.9.3'],
      ['color-name', '1.1.3'],
      ['escape-string-regexp', '1.0.5'],
      ['has-flag', '3.0.0'],
      ['supports-color', '5.5.0'],
    ],
  );

  assert.ok(result.tree.size > 0);
  // The aliased entry: installed at node_modules/chalk-new, but its real
  // registry name is "chalk" — confirmed by reading the fixture's
  // "node_modules/chalk-new" entry, which carries an explicit "name": "chalk".
  assert.deepEqual(result.tree.get('node_modules/chalk-new'), {
    name: 'chalk',
    version: '4.1.2',
    installPath: 'node_modules/chalk-new',
    dev: false,
  });
  assert.deepEqual(result.tree.get('node_modules/chalk'), {
    name: 'chalk',
    version: '2.4.2',
    installPath: 'node_modules/chalk',
    dev: false,
  });
});

test('package-lock.json: two incompatible versions of the same package keep their own install paths, not flattened', async () => {
  // The behaviour lockfile.ts's own doc calls out by name: "two packages
  // needing incompatible versions of a third", and why tree is keyed by
  // install path rather than by name. chalk@2.4.2 needs ansi-styles@^3.2.1
  // and has-flag@^3.0.0; the aliased chalk@4.1.2 needs ansi-styles@^4.1.0
  // and (via supports-color) has-flag@^4.0.0 — real, incompatible ranges
  // npm's own resolver could not hoist to one shared copy, confirmed by
  // reading the fixture: the nested versions live only under
  // node_modules/chalk-new/node_modules/*.
  const result = await read('npm');

  assert.deepEqual(result.tree.get('node_modules/ansi-styles'), {
    name: 'ansi-styles',
    version: '3.2.1',
    installPath: 'node_modules/ansi-styles',
    dev: false,
  });
  assert.deepEqual(result.tree.get('node_modules/chalk-new/node_modules/ansi-styles'), {
    name: 'ansi-styles',
    version: '4.3.0',
    installPath: 'node_modules/chalk-new/node_modules/ansi-styles',
    dev: false,
  });

  assert.deepEqual(result.tree.get('node_modules/has-flag'), {
    name: 'has-flag',
    version: '3.0.0',
    installPath: 'node_modules/has-flag',
    dev: false,
  });
  assert.deepEqual(result.tree.get('node_modules/chalk-new/node_modules/has-flag'), {
    name: 'has-flag',
    version: '4.0.0',
    installPath: 'node_modules/chalk-new/node_modules/has-flag',
    dev: false,
  });

  // versions stays top-level-only by design (see readLockfile's own comment):
  // it answers "what does this repo's own code resolve when it imports X",
  // which is the outer, non-nested copy — never the nested one, and never
  // both at once, since a Map can only carry one answer per name.
  assert.equal(result.versions.get('ansi-styles'), '3.2.1');
  assert.equal(result.versions.get('has-flag'), '3.0.0');
});

test('pnpm-lock.yaml: real pnpm output resolves to the right versions, tree and kind', async () => {
  const result = await read('pnpm');
  assert.equal(result.kind, 'pnpm-lock.yaml');
  assert.equal(result.unsupported, null);

  // Confirmed by reading test/fixtures/lockfiles/pnpm/pnpm-lock.yaml
  // directly: the `packages:` section has these three keys (the v9+
  // `name@version:` shape), each resolving to the version after the `@`.
  assert.deepEqual(
    [...result.versions.entries()].sort(),
    [
      ['@types/node', '22.15.30'],
      ['undici-types', '6.21.0'],
      ['zod', '3.25.76'],
    ],
  );

  for (const [name, version] of result.versions) {
    const installPath = `node_modules/${name}`;
    const entry = result.tree.get(installPath);
    assert.ok(entry, `expected a tree entry at ${installPath}`);
    assert.equal(entry?.name, name);
    assert.equal(entry?.version, version);
    assert.equal(entry?.installPath, installPath);
  }
});

test('yarn.lock: real yarn (classic) output resolves to the right versions, tree and kind', async () => {
  const result = await read('yarn');
  assert.equal(result.kind, 'yarn.lock');
  assert.equal(result.unsupported, null);

  // Confirmed by reading test/fixtures/lockfiles/yarn/yarn.lock directly:
  // three unindented headers (e.g. "zod@3.25.76:"), each followed by its own
  // indented `version "..."` line.
  assert.deepEqual(
    [...result.versions.entries()].sort(),
    [
      ['@types/node', '22.15.30'],
      ['undici-types', '6.21.0'],
      ['zod', '3.25.76'],
    ],
  );

  for (const [name, version] of result.versions) {
    const installPath = `node_modules/${name}`;
    const entry = result.tree.get(installPath);
    assert.ok(entry, `expected a tree entry at ${installPath}`);
    assert.equal(entry?.name, name);
    assert.equal(entry?.version, version);
    assert.equal(entry?.installPath, installPath);
  }
});

test('bun.lock: real bun output resolves to the right versions, tree and kind', async () => {
  const result = await read('bun');
  assert.equal(result.kind, 'bun.lock');
  assert.equal(result.unsupported, null);

  // Confirmed by reading test/fixtures/lockfiles/bun/bun.lock directly: the
  // `packages` object has these three keys, each an array whose element 0 is
  // "name@version" (the shape parseBunLock reads; the key itself is not used
  // for the version, per that function's own doc).
  assert.deepEqual(
    [...result.versions.entries()].sort(),
    [
      ['@types/node', '22.15.30'],
      ['undici-types', '6.21.0'],
      ['zod', '3.25.76'],
    ],
  );

  for (const [name, version] of result.versions) {
    const installPath = `node_modules/${name}`;
    const entry = result.tree.get(installPath);
    assert.ok(entry, `expected a tree entry at ${installPath}`);
    assert.equal(entry?.name, name);
    assert.equal(entry?.version, version);
    assert.equal(entry?.installPath, installPath);
  }
});

test('bun.lockb is recognised but reported unsupported, never a silently empty result', async () => {
  // The real case named in the task this test exists for: bun.lockb is a
  // binary format with no stable public spec, so readLockfile deliberately
  // never tries to parse it — but it must still say a lockfile was found and
  // could not be read, rather than reporting the same shape a repository
  // with no lockfile at all would produce (see readLockfile's own doc and
  // ecosystems.ts's module doc for why collapsing those two is the exact
  // "nobody looked" failure this codebase refuses to make).
  const result = await read('bun-lockb');
  assert.equal(result.kind, null);
  assert.equal(result.unsupported, 'bun.lockb');
  assert.equal(result.versions.size, 0);
  assert.equal(result.tree.size, 0);
});

test('no lockfile at all yields kind: null and an empty tree, distinctly from an unparseable one', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'emend-lockfile-none-'));
  try {
    const result = await readLockfile(dir);
    assert.equal(result.kind, null);
    // The distinction that matters: nothing was found, as opposed to
    // something found but unsupported (the bun.lockb case above) — callers
    // (ecosystems.ts) tell those two apart by this field.
    assert.equal(result.unsupported, null);
    assert.equal(result.versions.size, 0);
    assert.equal(result.tree.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
