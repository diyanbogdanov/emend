import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseSignature } from '../src/surface.ts';

// ---------------------------------------------------------------------------
// A signature must name a module, not a place on this disk
// ---------------------------------------------------------------------------

// `checker.typeToString()` renders a namespace re-export as
// `typeof import("<absolute path>")`, and Emend's own cache path carries the
// version in it. So the string changed on every upgrade whether or not the API
// did, and every namespace re-export in every package reported as breaking.
//
// Measured on activepieces: 26 of 81 breaking findings — 32% — were identical
// once the version in that path was normalised away. radix-ui alone was 21.
// The strings below are verbatim from the store.

test('a cached module path is reduced to the module it names', () => {
  assert.equal(
    normaliseSignature(
      'typeof import("/Users/someone/.emend/cache/@radix-ui+react-accordion/1.2.12/package/dist/index")',
    ),
    normaliseSignature(
      'typeof import("/Users/someone/.emend/cache/@radix-ui+react-accordion/1.2.20/package/dist/index")',
    ),
  );
});

test('two different modules still differ', () => {
  // The guard. Dropping the path entirely would make every namespace re-export
  // in a package compare equal to every other, which trades a flood of false
  // breaks for silence about real ones.
  const accordion = normaliseSignature(
    'typeof import("/Users/someone/.emend/cache/@radix-ui+react-accordion/1.2.12/package/dist/index")',
  );
  const avatar = normaliseSignature(
    'typeof import("/Users/someone/.emend/cache/@radix-ui+react-avatar/1.1.10/package/dist/index")',
  );
  assert.notEqual(accordion, avatar);
});

test('the subpath within a package is kept', () => {
  const external = normaliseSignature(
    'typeof import("/Users/someone/.emend/cache/zod/4.3.6/package/v4/classic/external")',
  );
  const other = normaliseSignature(
    'typeof import("/Users/someone/.emend/cache/zod/4.3.6/package/v4/classic/schemas")',
  );
  assert.notEqual(external, other);
});

test('no absolute path survives into a stored signature', () => {
  // It ends up in findings and in pull request bodies, and it is somebody's
  // home directory.
  const out = normaliseSignature(
    'typeof import("/Users/someone/.emend/cache/samlify/2.13.0/package/types/src/urn")',
  );
  assert.ok(!out.includes('/Users/'), out);
  assert.ok(out.includes('samlify'), out);
});

test('a qualified reference keeps its existing treatment', () => {
  // The rule that was already there: `import("…").Foo` becomes `Foo`.
  assert.equal(normaliseSignature('import("/tmp/x/package/dist/index").Foo'), 'Foo');
});
