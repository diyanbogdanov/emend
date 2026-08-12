import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseSignature,
  canonicalType,
} from '../src/surface.ts';

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

// ---------------------------------------------------------------------------
// Canonical type text
// ---------------------------------------------------------------------------

test('a reordered union is canonicalised to one order', () => {
  // TypeScript orders a union's members by internal type id, so which order is
  // printed depends on what else the program happened to load. query-core's
  // `QueryStatus` renders `"error" | "pending" | "success"` in 5.51 and
  // `"pending" | "success" | "error"` in 5.101 and denotes the same set both
  // times.
  assert.equal(
    canonicalType('"pending" | "success" | "error"'),
    canonicalType('"error" | "pending" | "success"'),
  );
});

test('a union nested anywhere is ordered where it sits', () => {
  // The cases a depth-counting scanner gets wrong, and the reason this parses
  // rather than scans: a `|` only unions within a comma slot, and `=>` binds
  // looser than `|`. Hand-rolled, `Record<string, "b" | "a">` came out as
  // `Record<"a" | string, "b">`.
  assert.equal(canonicalType('Record<string, "b" | "a">'), canonicalType('Record<string, "a" | "b">'));
  assert.equal(
    canonicalType('(a: "y" | "x") => "b" | "a"'),
    canonicalType('(a: "x" | "y") => "a" | "b"'),
  );
});

test('a union that gained a member is still a different union', () => {
  assert.notEqual(canonicalType('"error" | "pending"'), canonicalType('"error" | "pending" | "idle"'));
});

test('an intersection keeps its order', () => {
  // `A & B` commutes too, but member order there interacts with how overlapping
  // members render, and nothing measured needed it.
  assert.equal(canonicalType('A & B'), 'A & B');
});

test('text the parser cannot read comes back untouched', () => {
  // `typeToString` elides long object types as `... 5 more ...`, which is not
  // TypeScript. A canonicaliser that returned a mangled parse of that would be
  // comparing something the package never said.
  const elided = '{ get?: AxiosHeaders; ... 5 more ...; common?: AxiosHeaders; }';
  assert.equal(canonicalType(elided), elided);
});
