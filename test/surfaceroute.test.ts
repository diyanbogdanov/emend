import test from 'node:test';
import assert from 'node:assert/strict';
import { extractorFor } from '../src/surface.ts';

test('npm packages are claimed by the TypeScript extractor', () => {
  assert.equal(extractorFor('npm')?.id, 'typescript');
});

test('an ecosystem with no extractor is undefined, not an empty surface', () => {
  // An empty surface diffs as "nothing changed". Undefined routes to
  // `unanalyzable`, which is what "nobody looked" must render as.
  assert.equal(extractorFor('PyPI'), undefined);
  assert.equal(extractorFor('crates.io'), undefined);
});
