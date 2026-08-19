import test from 'node:test';
import assert from 'node:assert/strict';
import { resolverFor } from '../src/callsites.ts';

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
