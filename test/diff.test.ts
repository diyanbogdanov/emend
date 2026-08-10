import test from 'node:test';
import assert from 'node:assert/strict';
import {
  diffSurfaces,
  consumerImpacting,
  parameterList,
  requiredArity,
} from '../src/diff.ts';
import type { ApiSurface, ApiSymbol } from '../src/types.ts';

function sym(path: string, signature: string, extra: Partial<ApiSymbol> = {}): ApiSymbol {
  return { path, kind: 'function', signature, deprecated: false, optional: false, ...extra };
}

test('a deprecation carries the guidance its declaration gives', () => {
  // recharts 3 deprecates `Cell` and says what to do instead, in the declaration
  // itself: "use the `shape` prop or `content` prop". There is no replacement
  // *symbol*, so the candidate list cannot express the migration and the model
  // correctly reports that none exists — while the answer sits in the `.d.ts`
  // that Emend already downloaded and parsed.
  //
  // The whole wedge is that type declarations are machine-readable and
  // exhaustive. Reading the `@deprecated` tag as a boolean and discarding the
  // prose beside it throws away the half that says what to do.
  const guidance =
    'Please use the `shape` prop or `content` prop on the respective chart components instead of using `Cell`.';
  const diff = diffSurfaces(
    surface('2.15.4', [sym('Cell', 'FunctionComponent<Props>')]),
    surface('3.10.1', [sym('Cell', 'FunctionComponent<Props>', { deprecated: true, doc: guidance })]),
  );
  const change = diff.changes.find((c) => c.path === 'Cell');
  assert.equal(change?.kind, 'deprecated');
  assert.equal(change?.guidance, guidance);
});

test('guidance is only carried for the deprecation that needs it', () => {
  // Every symbol has documentation and almost none of it is a migration
  // instruction. Attaching it to unrelated changes would spend the prompt's
  // budget on prose the model must ignore.
  const diff = diffSurfaces(
    surface('1.0.0', [sym('gone', 'string', { doc: 'A perfectly ordinary description.' })]),
    surface('2.0.0', [sym('stayed', 'string')]),
  );
  assert.equal(diff.changes.find((c) => c.path === 'gone')?.guidance, undefined);
});

function surface(
  version: string,
  symbols: ApiSymbol[],
  extra: Partial<ApiSurface> = {},
): ApiSurface {
  return {
    pkg: 'demo',
    version,
    symbols: Object.fromEntries(symbols.map((s) => [s.path, s])),
    byTypeMember: {},
    aliases: {},
    entry: 'index.d.ts',
    ...extra,
  };
}

test('parameterList splits on top-level commas only', () => {
  // Generics and object literals contain commas that are not parameter
  // separators. Splitting naively would inflate the arity and make every
  // signature look like it changed.
  assert.deepEqual(parameterList('(a: string, b: number)'), ['a: string', 'b: number']);
  assert.deepEqual(parameterList('(a: Map<string, number>)'), ['a: Map<string, number>']);
  assert.deepEqual(parameterList('(a: { x: 1, y: 2 }, b: T)'), ['a: { x: 1, y: 2 }', 'b: T']);
  assert.deepEqual(parameterList('()'), []);
  assert.equal(parameterList('string'), null, 'non-callable signature has no parameter list');
});

test('requiredArity ignores optional markers nested inside parameter types', () => {
  // This is the exact bug that made the differ blind to real arity changes:
  // a `?:` inside an options object was counted as an optional *parameter*, so
  // `z.record`'s 1 -> 2 required-argument break scored as low confidence noise.
  const withNestedOptionals = '(valueType: V, params?: { errorMap?: E; description?: string })';
  assert.equal(requiredArity(withNestedOptionals), 1);

  const twoRequired = '(keyType: K, valueType: V, params?: { mode?: "strict" })';
  assert.equal(requiredArity(twoRequired), 2);

  assert.equal(requiredArity('(a: string, ...rest: number[])'), 1, 'rest params are optional');
  assert.equal(requiredArity('()'), 0);
});

test('a removed export is breaking with high confidence', () => {
  // The new surface has to contain *something*, or the absence of `doThing`
  // says only that nothing could be read out of it — see the empty-surface test.
  const from = surface('1.0.0', [sym('doThing', '(a: string) => void'), sym('kept', 'string')]);
  const to = surface('2.0.0', [sym('kept', 'string')]);
  const change = diffSurfaces(from, to).changes.find((c) => c.path === 'doThing');
  assert.equal(change?.kind, 'removed');
  assert.equal(change?.severity, 'breaking');
  assert.equal(change?.confidence, 'high');
});

test('gaining a required parameter is high confidence, unlike other signature edits', () => {
  // The distinction matters: a new required parameter is unambiguously breaking,
  // while any other signature edit might be a safe widening. Treating them alike
  // is what buries real breaks under thousands of false positives.
  const from = surface('1.0.0', [sym('f', '(a: string) => void'), sym('g', '(a: string) => void')]);
  const to = surface('2.0.0', [
    sym('f', '(a: string, b: number) => void'),
    sym('g', '(a: string | number) => void'),
  ]);
  const changes = diffSurfaces(from, to).changes;
  assert.equal(changes.find((c) => c.path === 'f')?.confidence, 'high');
  assert.equal(changes.find((c) => c.path === 'g')?.confidence, 'medium');
});

test('a newly deprecated symbol is reported as a deprecation', () => {
  const from = surface('1.0.0', [sym('old', 'string')]);
  const to = surface('1.1.0', [sym('old', 'string', { deprecated: true })]);
  const change = diffSurfaces(from, to).changes.find((c) => c.kind === 'deprecated');
  assert.equal(change?.path, 'old');
  assert.equal(change?.severity, 'deprecation');
});

test('a truncated target surface never produces removals', () => {
  // Absence in a truncated surface means "past the cutoff", not "deleted".
  // Reporting removals here would fabricate breaking changes wholesale — the
  // single worst failure mode for a tool whose value is trustworthy detection.
  const from = surface('1.0.0', [sym('a', 'string'), sym('b', 'string')]);
  const to = surface('2.0.0', [sym('a', 'string')], { truncated: true });
  const diff = diffSurfaces(from, to);
  assert.equal(diff.changes.filter((c) => c.kind === 'removed').length, 0);
  assert.match(diff.note ?? '', /truncated/);
});

test('a package without type declarations is unanalyzable, not clean', () => {
  const from = surface('1.0.0', [sym('a', 'string')], { entry: null });
  const to = surface('2.0.0', []);
  const diff = diffSurfaces(from, to);
  assert.equal(diff.unanalyzable, true);
  assert.equal(diff.changes.length, 0, 'no change claims may be made about an unanalyzable package');
  assert.match(diff.note ?? '', /no type declarations/);
});

test('a major jump drops medium-confidence signature noise but keeps removals', () => {
  // Across a major version, internal rewrites change nearly every signature
  // string without changing the contract. Scanning zod 3.22 -> 4.4 this way
  // produced 2,100+ "breaking" changes, essentially all noise.
  const from = surface('3.0.0', [sym('kept', '(a: A) => void'), sym('gone', 'string')]);
  const to = surface('4.0.0', [sym('kept', '(a: B) => void')]);

  const impacting = consumerImpacting(diffSurfaces(from, to));
  assert.deepEqual(
    impacting.map((c) => c.path),
    ['gone'],
    'only the removal survives a major-version filter',
  );
});

test('within one major, a signature change is still reported', () => {
  const from = surface('3.0.0', [sym('kept', '(a: A) => void')]);
  const to = surface('3.1.0', [sym('kept', '(a: B) => void')]);
  const impacting = consumerImpacting(diffSurfaces(from, to));
  assert.deepEqual(impacting.map((c) => c.path), ['kept']);
});

test('a symbol re-exported under an alias is not reported as removed', () => {
  // @radix-ui/react-avatar 1.1.11 exported `Root` directly; 1.2.6 exports
  // `Avatar as Root`. The surface walk claims the shared symbol under `Avatar`
  // and records `Root` in `aliases`, so checking only `symbols` sees `Root`
  // vanish. That produced three high-confidence "removed" findings, and a pull
  // request, for a package that still exports all three names.
  const from = surface('1.1.11', [
    sym('Avatar', 'React.ForwardRefExoticComponent<any>'),
    sym('Root', 'React.ForwardRefExoticComponent<any>'),
  ]);
  const to = surface(
    '1.2.6',
    [sym('Avatar', 'React.ForwardRefExoticComponent<any>')],
    { aliases: { Root: 'Avatar' } },
  );

  const removed = diffSurfaces(from, to).changes.filter((c) => c.kind === 'removed');
  assert.deepEqual(removed, [], 'an aliased re-export is still exported');
  assert.equal(consumerImpacting(diffSurfaces(from, to)).length, 0);
});

test('a symbol absent from both symbols and aliases is still a removal', () => {
  // The alias check must not become a blanket amnesty: a genuine deletion has
  // to keep reporting, or the fix above would trade false alarms for silence.
  const from = surface('1.0.0', [sym('gone', '() => void'), sym('kept', '() => void')]);
  const to = surface('2.0.0', [sym('kept', '() => void')], { aliases: { other: 'kept' } });

  const removed = diffSurfaces(from, to).changes.filter((c) => c.kind === 'removed');
  assert.equal(removed.length, 1);
  assert.equal(removed[0]?.path, 'gone');
});

// ---------------------------------------------------------------------------
// A widening is not a break
// ---------------------------------------------------------------------------

// The signatures below are the real ones, read out of the store after scanning
// activepieces — not invented. A first attempt at this rule worked on fixtures
// I made up and could not fire on any of them, which is why they are copied
// verbatim here.
//
// `checker.typeToString()` prints type parameters by name and never by
// declaration, so `AxiosRequestConfig<D>` -> `AxiosRequestConfig<D, P>` carries
// no clue whether `P` has a default. That answer only exists where the
// declaration does, which is why `surface.ts` now records it.

test('a type parameter added with a default is a feature, not a break', () => {
  // axios 1.18.0 -> 1.19.0, verbatim. Every existing use still compiles:
  // `AxiosRequestConfig` and `AxiosRequestConfig<Foo>` both still bind.
  const changes = diffSurfaces(
    surface('1.18.0', [
      sym('AxiosRequestConfig', 'AxiosRequestConfig<D>', {
        typeParams: [{ name: 'D', defaulted: true }],
      }),
    ]),
    surface('1.19.0', [
      sym('AxiosRequestConfig', 'AxiosRequestConfig<D, P>', {
        typeParams: [
          { name: 'D', defaulted: true },
          { name: 'P', defaulted: true },
        ],
      }),
    ]),
  ).changes;
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.severity, 'feature');
});

test('a widening is still one when the new parameter threads through the signature', () => {
  // `isAxiosError`, verbatim. The return type mentions the new parameter, so the
  // strings differ in more than the parameter list — and it is still compatible,
  // because everything that bound before still binds.
  const changes = diffSurfaces(
    surface('1.18.0', [
      sym('isAxiosError', '<T = any, D = any>(payload: any) => payload is AxiosError<T, D>', {
        typeParams: [
          { name: 'T', defaulted: true },
          { name: 'D', defaulted: true },
        ],
      }),
    ]),
    surface('1.19.0', [
      sym(
        'isAxiosError',
        '<T = any, D = any, P = any>(payload: any) => payload is AxiosError<T, D, P>',
        {
          typeParams: [
            { name: 'T', defaulted: true },
            { name: 'D', defaulted: true },
            { name: 'P', defaulted: true },
          ],
        },
      ),
    ]),
  ).changes;
  assert.equal(changes[0]?.severity, 'feature');
});

test('a type parameter added without a default still breaks', () => {
  // `Config<Foo>` no longer binds: the second has nothing to fall back to.
  const changes = diffSurfaces(
    surface('1.0.0', [sym('Config', 'Config<D>', { typeParams: [{ name: 'D', defaulted: true }] })]),
    surface('2.0.0', [
      sym('Config', 'Config<D, P>', {
        typeParams: [
          { name: 'D', defaulted: true },
          { name: 'P', defaulted: false },
        ],
      }),
    ]),
  ).changes;
  assert.equal(changes[0]?.severity, 'breaking');
});

test('a defaulted type parameter does not excuse the rest of the signature', () => {
  // The limit that keeps this from swallowing real breaks. Adding a defaulted
  // parameter is provably compatible on its own and says nothing about a value
  // parameter that changed beside it — `path` went from string to number.
  const changes = diffSurfaces(
    surface('1.0.0', [
      sym('read', '<T = any>(path: string) => T', { typeParams: [{ name: 'T', defaulted: true }] }),
    ]),
    surface('2.0.0', [
      sym('read', '<T = any, P = any>(path: number) => T', {
        typeParams: [
          { name: 'T', defaulted: true },
          { name: 'P', defaulted: true },
        ],
      }),
    ]),
  ).changes;
  assert.equal(changes[0]?.severity, 'breaking');
});

test('a renamed type parameter is not a widening', () => {
  const changes = diffSurfaces(
    surface('1.0.0', [sym('Box', 'Box<T>', { typeParams: [{ name: 'T', defaulted: true }] })]),
    surface('2.0.0', [
      sym('Box', 'Box<U, P>', {
        typeParams: [
          { name: 'U', defaulted: true },
          { name: 'P', defaulted: true },
        ],
      }),
    ]),
  ).changes;
  assert.equal(changes[0]?.severity, 'breaking');
});

test('a new surface with no symbols cannot support a removal claim', () => {
  // Measured on activepieces. Every package that reported a removal reported
  // *only* removals — slugify 1 of 1, fuse.js 1 of 1, react-table 5 of 5 — which
  // is the shape of the new version's declarations failing to read, not of an
  // API being deleted. Proven on slugify 1.6.6 -> 1.6.9, a patch release: npm
  // shows the same `types` field, the same `main`, no exports map, and more
  // exported declarations after than before. Nothing was removed.
  //
  // `entry === null` was already guarded. An entry that resolved and yielded
  // nothing is the same failure one step later, and it read as a deleted API.
  const diff = diffSurfaces(
    surface('1.6.6', [sym('slugify', 'typeof slugify')]),
    surface('1.6.9', []),
  );
  assert.equal(diff.changes.filter((c) => c.kind === 'removed').length, 0);
  assert.match(diff.note ?? '', /no symbols|could not be read/i);
});

test('a genuine removal alongside symbols that survived is still reported', () => {
  // The limit. @tanstack/react-table 8 -> 9 really did restructure, and a new
  // surface that reads fine and simply lacks a symbol is evidence of removal.
  const diff = diffSurfaces(
    surface('8.19.2', [sym('useReactTable', 'typeof useReactTable'), sym('flexRender', 'typeof flexRender')]),
    surface('9.1.2', [sym('flexRender', 'typeof flexRender')]),
  );
  assert.equal(diff.changes.filter((c) => c.kind === 'removed').length, 1);
});

test('a symbol that moved to a new path is not a removal', () => {
  // The real slugify 1.6.6 -> 1.6.9 symbol tables, read out of the extractor.
  // Adding `export { _default as default }` changed which root is walked, so
  // every path was renamed and all three old symbols read as deleted. The
  // function is still there — `_default` carries the identical signature.
  //
  // The evidence that makes this checkable rather than a guess: an identically
  // signatured symbol that is *newly present*. A symbol that existed in both
  // versions cannot be where a third one went.
  const diff = diffSurfaces(
    surface('1.6.6', [
      sym('slugify', 'typeof slugify'),
      sym('slugify.extend', '(args: ExtendArgs) => void'),
    ]),
    surface('1.6.9', [
      sym('_default', 'typeof slugify'),
      sym('extend', '(args: ExtendArgs) => void'),
    ]),
  );
  assert.equal(diff.changes.filter((c) => c.kind === 'removed').length, 0);
  assert.match(diff.note ?? '', /slugify/);
});

test('a genuine removal is still reported when nothing took its place', () => {
  const diff = diffSurfaces(
    surface('1.0.0', [sym('gone', 'typeof gone'), sym('kept', 'string')]),
    surface('2.0.0', [sym('kept', 'string')]),
  );
  assert.equal(diff.changes.filter((c) => c.kind === 'removed').length, 1);
});

test('a symbol present in both versions cannot be where a third one went', () => {
  // The guard that keeps this from swallowing real deletions. `bar` shares a
  // signature with the removed `foo`, but `bar` was there before — it is not
  // somewhere `foo` moved to, it is an unrelated symbol that happens to match.
  const diff = diffSurfaces(
    surface('1.0.0', [sym('foo', 'string'), sym('bar', 'string')]),
    surface('2.0.0', [sym('bar', 'string')]),
  );
  assert.equal(diff.changes.filter((c) => c.kind === 'removed').length, 1);
});
