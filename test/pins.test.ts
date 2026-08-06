import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPins,
  findPinConflicts,
  planPinRepair,
  resolvedVersions,
  type VersionPin,
} from '../src/pins.ts';

const DOCKERFILE = [
  'FROM node:18-alpine AS builder', // 1
  'WORKDIR /app', // 2
  'COPY package*.json ./', // 3
  'RUN npm ci', // 4
  '', // 5
  'FROM mcr.microsoft.com/playwright:v1.62.1-jammy', // 6
  'COPY --from=builder /app /app', // 7
].join('\n');

const WORKFLOW = [
  'jobs:', // 1
  '  build:', // 2
  '    steps:', // 3
  '      - uses: actions/setup-node@v4', // 4
  '        with:', // 5
  "          node-version: '20'", // 6
].join('\n');

const MANIFEST = JSON.stringify(
  { engines: { node: '>=22' }, dependencies: { playwright: '^1.63.0' } },
  null,
  2,
);

function files(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

// ---------------------------------------------------------------------------
// extractPins — a version written as a literal, wherever it lives
// ---------------------------------------------------------------------------

test('a Dockerfile base image pins the tool it ships', () => {
  // The a scanned repository case: the image tag and the npm dependency must agree, and
  // nothing in a normal build checks that they do.
  const pins = extractPins(files({ Dockerfile: DOCKERFILE }));
  const playwright = pins.find((p) => p.subject === 'playwright');
  assert.equal(playwright?.version, '1.62.1');
  assert.equal(playwright?.kind, 'docker-image');
  assert.equal(playwright?.line, 6);
  // The exact text has to round-trip into a find/replace edit, so the tag must
  // be recoverable from it rather than reconstructed.
  assert.ok(playwright?.text.includes('v1.62.1'));
});

test('a node base image is read as a node version, not an opaque image', () => {
  // `FROM node:18` is the most common way a repository pins node, and treating
  // it as just another image would leave the most frequent inconsistency
  // invisible.
  const pins = extractPins(files({ Dockerfile: DOCKERFILE }));
  const node = pins.find((p) => p.kind === 'node-version' && p.file === 'Dockerfile');
  assert.equal(node?.version, '18');
  assert.equal(node?.line, 1);
});

test('node versions are collected from every place a repository declares one', () => {
  const pins = extractPins(
    files({
      '.nvmrc': '22\n',
      'package.json': MANIFEST,
      '.github/workflows/ci.yml': WORKFLOW,
      Dockerfile: DOCKERFILE,
    }),
  );
  const versions = pins
    .filter((p) => p.kind === 'node-version')
    .map((p) => `${p.file}=${p.version}`)
    .sort();
  assert.deepEqual(versions, [
    '.github/workflows/ci.yml=20',
    '.nvmrc=22',
    'Dockerfile=18',
    'package.json=22',
  ]);
});

test('a floating tag is not a pin', () => {
  // `FROM node:latest` declares nothing to disagree with. Reporting it as a
  // conflict would be noise, and Emend's whole claim is that its findings are
  // evidence rather than suspicion.
  const pins = extractPins(files({ Dockerfile: 'FROM node:latest\nFROM redis\n' }));
  assert.deepEqual(pins, []);
});

// ---------------------------------------------------------------------------
// findPinConflicts — only what can be proven
// ---------------------------------------------------------------------------

test('an image tag that disagrees with the installed package is a conflict', () => {
  // Provable: the lockfile says what is actually installed, so the image tag is
  // wrong rather than merely different.
  const pins = extractPins(files({ Dockerfile: DOCKERFILE, 'package.json': MANIFEST }));
  const conflicts = findPinConflicts(pins, new Map([['playwright', '1.63.0']]));
  const playwright = conflicts.find((cf) => cf.subject === 'playwright');
  assert.equal(playwright?.expected, '1.63.0');
  assert.equal(playwright?.authority, 'the installed playwright');
  assert.equal(playwright?.pins.length, 1);
  assert.equal(playwright?.pins[0]?.version, '1.62.1');
});

test('an image tag that already agrees is not a conflict', () => {
  const pins = extractPins(files({ Dockerfile: DOCKERFILE }));
  const conflicts = findPinConflicts(pins, new Map([['playwright', '1.62.1']]));
  assert.equal(
    conflicts.find((cf) => cf.subject === 'playwright'),
    undefined,
  );
});

test('node versions that disagree are reported against the declared engine', () => {
  // `engines` is the repository's own statement of intent, so it is the
  // authority when present — Emend does not get to pick a version the project
  // never asked for.
  //
  // `.nvmrc` deliberately disagrees with `engines` here. When it agreed, this
  // test passed just as happily against "use whichever pin came first", which
  // means it was not testing the rule it is named for.
  const pins = extractPins(
    files({
      '.nvmrc': '18\n',
      'package.json': MANIFEST,
      '.github/workflows/ci.yml': WORKFLOW,
      Dockerfile: DOCKERFILE,
    }),
  );
  const conflicts = findPinConflicts(pins, new Map());
  const node = conflicts.find((cf) => cf.subject === 'node');
  assert.equal(node?.expected, '22', 'engines wins, not the first pin encountered');
  assert.equal(node?.authority, 'the declared engines.node');
  // Every pin that disagrees, and only those.
  assert.deepEqual(
    node?.pins.map((p) => p.file).sort(),
    ['.github/workflows/ci.yml', '.nvmrc', 'Dockerfile'],
  );
});

test('node versions that all agree produce nothing', () => {
  const pins = extractPins(files({ '.nvmrc': '22\n', 'package.json': MANIFEST }));
  assert.deepEqual(findPinConflicts(pins, new Map()), []);
});

test('without a declared engine, disagreeing node versions are reported but not resolved', () => {
  // Three files, three answers, and no statement of intent to arbitrate. Saying
  // "these disagree" is honest; picking a winner would be the guessing the
  // planner already refuses to do.
  const pins = extractPins(
    files({ '.nvmrc': '22\n', '.github/workflows/ci.yml': WORKFLOW, Dockerfile: DOCKERFILE }),
  );
  const node = findPinConflicts(pins, new Map()).find((cf) => cf.subject === 'node');
  assert.equal(node?.expected, null, 'no authority means no target version');
  assert.equal(node?.pins.length, 3, 'every disagreeing pin is still named');
});

// ---------------------------------------------------------------------------
// planPinRepair — the fix needs no model
// ---------------------------------------------------------------------------

test('a drifted tag is repaired by substituting the version, leaving the rest alone', () => {
  // `v1.62.1-jammy` must become `v1.63.0-jammy`: the distro suffix and the `v`
  // prefix are the repository's choices and rewriting them would be an edit the
  // drift did not call for.
  const pins = extractPins(files({ Dockerfile: DOCKERFILE }));
  const [conflict] = findPinConflicts(pins, new Map([['playwright', '1.63.0']]));
  const edits = planPinRepair(conflict!);
  assert.equal(edits.length, 1);
  assert.equal(edits[0]?.find, 'mcr.microsoft.com/playwright:v1.62.1-jammy');
  assert.equal(edits[0]?.replace, 'mcr.microsoft.com/playwright:v1.63.0-jammy');
  assert.equal(edits[0]?.file, 'Dockerfile');
  assert.equal(edits[0]?.line, 6);
});

test('every disagreeing pin gets its own edit', () => {
  const pins = extractPins(
    files({
      '.nvmrc': '18\n',
      'package.json': MANIFEST,
      '.github/workflows/ci.yml': WORKFLOW,
      Dockerfile: DOCKERFILE,
    }),
  );
  const node = findPinConflicts(pins, new Map()).find((cf) => cf.subject === 'node');
  const edits = planPinRepair(node!);
  assert.deepEqual(edits.map((e) => e.file).sort(), [
    '.github/workflows/ci.yml',
    '.nvmrc',
    'Dockerfile',
  ]);
  assert.ok(edits.every((e) => e.replace.includes('22')));
  // The surrounding syntax is preserved in each file's own idiom.
  assert.equal(edits.find((e) => e.file === 'Dockerfile')?.replace, 'node:22-alpine');
  assert.equal(
    edits.find((e) => e.file === '.github/workflows/ci.yml')?.replace,
    "node-version: '22'",
  );
});

test('a conflict with nothing to arbitrate produces no edits', () => {
  // Reporting a disagreement is honest; inventing a version to resolve it is
  // the guess the planner refuses to make. A human decides this one.
  const pins = extractPins(
    files({ '.nvmrc': '22\n', '.github/workflows/ci.yml': WORKFLOW, Dockerfile: DOCKERFILE }),
  );
  const node = findPinConflicts(pins, new Map()).find((cf) => cf.subject === 'node');
  assert.equal(node?.expected, null);
  assert.deepEqual(planPinRepair(node!), []);
});

test('a version guessed from a range is never used as the authority', () => {
  // `InstalledDependency.source` of `range` means the version was inferred from
  // the declared semver range and may name a release that was never published.
  // Telling someone their Dockerfile disagrees with a version that might not
  // exist is exactly the false certainty the honesty rules forbid, and the
  // lockfile-backed case is indistinguishable to whoever reads the finding.
  const resolved = resolvedVersions([
    { name: 'playwright', installed: '1.63.0', source: 'range' },
    { name: 'zod', installed: '3.22.4', source: 'lockfile' },
    { name: 'react', installed: '19.0.0', source: 'node_modules' },
    { name: 'ghost', installed: null, source: 'none' },
  ]);
  assert.equal(resolved.get('playwright'), undefined, 'a guess cannot arbitrate');
  assert.equal(resolved.get('zod'), '3.22.4');
  assert.equal(resolved.get('react'), '19.0.0');
  assert.equal(resolved.get('ghost'), undefined);
});

test('a pin for a package the repository does not install is left alone', () => {
  // Emend can only prove a mismatch against something it resolved. An image for
  // a tool that is not an npm dependency is outside what it can check, and
  // reporting it would be suspicion rather than evidence.
  const pins: VersionPin[] = extractPins(
    files({ Dockerfile: 'FROM postgres:16.2\n' }),
  );
  assert.equal(pins.length, 1);
  assert.deepEqual(findPinConflicts(pins, new Map()), []);
});
