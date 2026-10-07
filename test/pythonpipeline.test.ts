import test from 'node:test';
import assert from 'node:assert/strict';
import { clientFor } from '../src/registry.ts';
import { extractorFor } from '../src/surface.ts';
import type { InstalledDependency } from '../src/types.ts';

/**
 * Routing only, no network. analyze.ts and fix.ts pass a dependency's own
 * `ecosystem` straight to `clientFor`/`extractorFor`; running the real
 * pipeline to prove that would need the registry and a downloaded
 * tarball/wheel on the wire. This proves the narrower, testable claim those
 * calls depend on: given a dependency carrying its own ecosystem, routing
 * reaches the adapter that actually understands it, not whichever adapter
 * used to be hardcoded.
 */

const pypiDep: InstalledDependency = {
  name: 'requests',
  ecosystem: 'PyPI',
  installed: '2.31.0',
  declared: '2.31.0',
  dev: false,
  source: 'lockfile',
  declaredIn: [''],
};

const npmDep: InstalledDependency = {
  name: 'zod',
  ecosystem: 'npm',
  installed: '3.22.0',
  declared: '^3.22.0',
  dev: false,
  source: 'lockfile',
  declaredIn: [''],
};

const crateDep: InstalledDependency = {
  name: 'serde',
  ecosystem: 'crates.io',
  installed: '1.0.0',
  declared: '1.0.0',
  dev: false,
  source: 'lockfile',
  declaredIn: [''],
};

test('a dependency carrying ecosystem PyPI routes to the Python extractor and the PyPI client', () => {
  assert.equal(extractorFor(pypiDep.ecosystem)?.id, 'python');
  assert.equal(clientFor(pypiDep.ecosystem)?.id, 'pypi');
});

test('a dependency carrying ecosystem npm routes to the TypeScript extractor and the npm client', () => {
  assert.equal(extractorFor(npmDep.ecosystem)?.id, 'typescript');
  assert.equal(clientFor(npmDep.ecosystem)?.id, 'npm');
});

test('a dependency whose ecosystem no extractor claims yields undefined, never a fallback to TypeScript', () => {
  // The exact danger this task exists to close: falling back to the
  // TypeScript extractor for an ecosystem it does not understand would hand
  // it a Rust crate's package directory, extract an empty surface from it,
  // and diff.ts reads an empty surface as "nothing changed" — rendering a
  // real upgrade as clean, the most dangerous wrong answer this system can
  // give. Undefined forces the caller (analyze.ts) to report `unanalyzable`
  // instead of silently guessing at an extractor.
  assert.equal(extractorFor(crateDep.ecosystem), undefined);
  assert.equal(clientFor(crateDep.ecosystem), undefined);
});
