import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PACKAGE_ROOT, emendPath } from '../src/paths.ts';

test('the package root is Emend’s own, not whichever package.json is nearest', () => {
  // The failure this guards is silent and remote: resolve to a neighbouring
  // package and `skills/` comes back empty, so a review runs under no standard
  // at all and reports that it reviewed.
  const manifest = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
    name?: string;
  };
  assert.equal(manifest.name, 'emend-cli');
});

test('what ships beside the code is found through the root, not by counting `..`', () => {
  // Both of these were resolved by counting directories up from the module that
  // wanted them, which encodes one layout. `dist/cli.js` is a different one, and
  // the same count that lands on `skills/` from `src/llm/` lands *above* the
  // package from there. Asked through the root, both layouts answer the same.
  for (const dir of ['skills', 'fixtures', 'bin']) {
    assert.ok(existsSync(emendPath(dir)), `${dir}/ must be reachable from the package root`);
  }
  assert.ok(existsSync(emendPath('bin', 'emend.mjs')), 'including the launcher a child re-enters through');
});
