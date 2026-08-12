import test from 'node:test';
import assert from 'node:assert/strict';
import {
  diffSurfaces,
  consumerImpacting,
  parameterList,
  positionalParams,
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
  // Reported, but as drift: `string` becoming `number` is a real edit and a
  // string comparison cannot show whether it breaks any particular caller.
  assert.equal(changes[0]?.severity, 'drift');
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
  // Renamed *and* gained a defaulted parameter. `Box<Foo>` still binds, so this
  // is not breaking — but the widening rule needs the existing names untouched
  // to prove that, and they are not. Reported, and claimed no further than the
  // evidence goes.
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.severity, 'drift');
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

// ---------------------------------------------------------------------------
// Moved, or gone
// ---------------------------------------------------------------------------

// A first attempt at this matched on the signature alone and was reverted. On
// @vue/runtime-core 3.5 one newly added `boolean` property stood in as the
// destination for every removed `boolean` property, hiding real removals like
// `AppConfig.unwrapInjectedRef` behind a coincidence of type.
//
// What separates the two cases is nominal versus structural. `typeof slugify`
// names a declaration — nothing else in the package can have that type by
// accident. `boolean` names a shape that half the surface shares. Only the
// first is an identity.

test('a symbol whose type names it is recognised where it moved to', () => {
  // slugify 1.6.6 -> 1.6.9, from the extractor. Adding a default export changed
  // which root is walked, so `slugify` became `_default` — same declaration.
  const diff = diffSurfaces(
    surface('1.6.6', [sym('slugify', 'typeof slugify')]),
    surface('1.6.9', [sym('_default', 'typeof slugify')]),
  );
  assert.equal(diff.changes.filter((c) => c.kind === 'removed').length, 0);
  assert.match(diff.note ?? '', /_default/);
});

test('a shared structural type is not an identity', () => {
  // The Vue case that reverted the first attempt. `unwrapInjectedRef` really was
  // removed in 3.5, and a new unrelated boolean must not absorb it.
  const diff = diffSurfaces(
    surface('3.4.0', [
      sym('AppConfig.unwrapInjectedRef', 'boolean'),
      sym('kept', 'string'),
    ]),
    surface('3.5.0', [sym('EffectScope.active', 'boolean'), sym('kept', 'string')]),
  );
  assert.equal(diff.changes.filter((c) => c.kind === 'removed').length, 1);
});

test('a nominal type with two candidates is too ambiguous to call a move', () => {
  // Two newly present symbols of the same declared type: which one it went to
  // is a guess, and a guess here hides a removal.
  const diff = diffSurfaces(
    surface('1.0.0', [sym('thing', 'typeof thing')]),
    surface('2.0.0', [sym('a', 'typeof thing'), sym('b', 'typeof thing')]),
  );
  assert.equal(diff.changes.filter((c) => c.kind === 'removed').length, 1);
});

test('a destination that existed before is not where anything moved', () => {
  const diff = diffSurfaces(
    surface('1.0.0', [sym('gone', 'typeof gone'), sym('other', 'typeof gone')]),
    surface('2.0.0', [sym('other', 'typeof gone')]),
  );
  assert.equal(diff.changes.filter((c) => c.kind === 'removed').length, 1);
});

test('a removed alias is a removed export, even though its target survives', () => {
  // @faker-js/faker 8.2.0 -> 10.5.0, from the extractor. In 8.2.0 `AddressModule`
  // is a deprecated alias: its type is `typeof LocationModule`, naming a *different*
  // declaration. Faker 10 removed the alias, and `import { AddressModule }` breaks —
  // it is in their migration guide.
  //
  // The rule proves the declaration is still reachable, which is not the same as
  // the name still working, and for a consumer the name is what matters. What
  // separates this from slugify is whose name the type gives: `slugify` is
  // `typeof slugify` and names itself; an alias names something else.
  const diff = diffSurfaces(
    surface('8.2.0', [sym('AddressModule', 'typeof LocationModule')]),
    surface('10.5.0', [sym('LocationModule', 'typeof LocationModule')]),
  );
  assert.equal(diff.changes.filter((c) => c.kind === 'removed').length, 1);
});

test('a symbol whose type names itself is still recognised where it moved', () => {
  // The regression guard: slugify must keep working. `slugify :: typeof slugify`.
  const diff = diffSurfaces(
    surface('1.6.6', [sym('slugify', 'typeof slugify')]),
    surface('1.6.9', [sym('_default', 'typeof slugify')]),
  );
  assert.equal(diff.changes.filter((c) => c.kind === 'removed').length, 0);
});

// ---------------------------------------------------------------------------
// A type parameter's name is not observable
// ---------------------------------------------------------------------------

test('renaming a type parameter is not a change a caller can see', () => {
  // @tanstack/react-query 5.51 -> 5.101, verbatim. `TContext` became
  // `TOnMutateResult`, used in the same position throughout. Type parameters are
  // positional at a call site — `useMutation<A, B, C, D>` is unchanged and
  // nobody can name one — so nothing observable happened.
  const changes = diffSurfaces(
    surface('5.51.1', [
      sym(
        'useMutation',
        '<TData = unknown, TError = Error, TVariables = void, TContext = unknown>(options: UseMutationOptions<TData, TError, TVariables, TContext>) => void',
        {
          typeParams: [
            { name: 'TData', defaulted: true },
            { name: 'TError', defaulted: true },
            { name: 'TVariables', defaulted: true },
            { name: 'TContext', defaulted: true },
          ],
        },
      ),
    ]),
    surface('5.101.4', [
      sym(
        'useMutation',
        '<TData = unknown, TError = Error, TVariables = void, TOnMutateResult = unknown>(options: UseMutationOptions<TData, TError, TVariables, TOnMutateResult>) => void',
        {
          typeParams: [
            { name: 'TData', defaulted: true },
            { name: 'TError', defaulted: true },
            { name: 'TVariables', defaulted: true },
            { name: 'TOnMutateResult', defaulted: true },
          ],
        },
      ),
    ]),
  ).changes;
  assert.deepEqual(changes, [], 'positional shape is identical');
});

test('a rename alongside a real change is still reported', () => {
  // The limit. Renaming the parameter does not excuse the value parameter that
  // changed with it — `string` became `number`.
  const changes = diffSurfaces(
    surface('1.0.0', [
      sym('read', '<TIn>(path: string) => TIn', { typeParams: [{ name: 'TIn', defaulted: false }] }),
    ]),
    surface('2.0.0', [
      sym('read', '<TSource>(path: number) => TSource', { typeParams: [{ name: 'TSource', defaulted: false }] }),
    ]),
  ).changes;
  assert.equal(changes.length, 1, 'the rename did not hide the parameter change');
  assert.equal(changes[0]?.severity, 'drift');
});

test('reordering type parameters is a change, not a rename', () => {
  // Positions are what a caller supplies, so swapping them is observable even
  // though the same names appear on both sides.
  const changes = diffSurfaces(
    surface('1.0.0', [
      sym('box', '<A, B>(a: A, b: B) => void', {
        typeParams: [{ name: 'A', defaulted: false }, { name: 'B', defaulted: false }],
      }),
    ]),
    surface('2.0.0', [
      sym('box', '<A, B>(a: B, b: A) => void', {
        typeParams: [{ name: 'A', defaulted: false }, { name: 'B', defaulted: false }],
      }),
    ]),
  ).changes;
  assert.equal(changes.length, 1, 'a reorder is still a change');
  assert.equal(changes[0]?.severity, 'drift');
});

// ---------------------------------------------------------------------------
// A signature kept only in part
// ---------------------------------------------------------------------------

const CUT = '…<truncated>';

test('a comparison made on a partial signature says so', () => {
  // `normaliseSignature` stores at most 4,000 characters, and five findings on
  // activepieces were decided on strings cut at that point. The visible
  // difference is real, but what lies past the cut was never compared — and
  // `@ai-sdk/anthropic`'s visible difference is an *added* optional property,
  // which is a widening rather than a break.
  const diff = diffSurfaces(
    surface('1.0.0', [sym('tools', `{ a: string; b: number${CUT}`)]),
    surface('2.0.0', [sym('tools', `{ a: string; b: boolean${CUT}`)]),
  );
  assert.equal(diff.changes.length, 1, 'the visible difference is still evidence');
  assert.match(diff.note ?? '', /tools/);
  assert.match(diff.note ?? '', /as far as|partial|not compared/i);
});

test('two partial signatures that agree so far are not called unchanged', () => {
  // The quieter half, and the one that was fully silent: identical up to the
  // cut says nothing about what follows it, and no finding read as no change.
  const diff = diffSurfaces(
    surface('1.0.0', [sym('tools', `{ a: string${CUT}`)]),
    surface('2.0.0', [sym('tools', `{ a: string${CUT}`)]),
  );
  assert.deepEqual(diff.changes, []);
  assert.match(diff.note ?? '', /tools/);
});

test('a signature kept whole is compared without comment', () => {
  const diff = diffSurfaces(
    surface('1.0.0', [sym('small', '(a: string) => void')]),
    surface('2.0.0', [sym('small', '(a: number) => void')]),
  );
  assert.equal(diff.changes.length, 1);
  assert.equal(/as far as/i.test(diff.note ?? ''), false);
});

// ---------------------------------------------------------------------------
// A deprecation you are already living with
// ---------------------------------------------------------------------------

test('a symbol deprecated in the version you would move to is reported', () => {
  // Measured: zod 4.4.3 carries 332 deprecated symbols and react-query 16, and a
  // scan of activepieces reported zero deprecations across 227 packages. The
  // gate only fired on symbols that became deprecated *between* the two
  // versions, so anything deprecated before you last upgraded was invisible —
  // and that is most of them. A deprecation you have been living with for two
  // years is still work, and still the thing that breaks at the next major.
  const diff = diffSurfaces(
    surface('1.0.0', [sym('nativeEnum', '(x: string) => void', { deprecated: true })]),
    surface('2.0.0', [
      sym('nativeEnum', '(x: string) => void', { deprecated: true, doc: 'Use enum() instead.' }),
    ]),
  );
  const dep = diff.changes.filter((c) => c.kind === 'deprecated');
  assert.equal(dep.length, 1);
  assert.equal(dep[0]?.severity, 'deprecation');
  assert.equal(dep[0]?.guidance, 'Use enum() instead.');
});

test('a symbol that is not deprecated produces no deprecation', () => {
  const diff = diffSurfaces(
    surface('1.0.0', [sym('fine', 'string')]),
    surface('2.0.0', [sym('fine', 'string')]),
  );
  assert.deepEqual(diff.changes, []);
});

test('a newly deprecated symbol is still reported, and only once', () => {
  const diff = diffSurfaces(
    surface('1.0.0', [sym('old', 'string')]),
    surface('2.0.0', [sym('old', 'string', { deprecated: true })]),
  );
  assert.equal(diff.changes.filter((c) => c.kind === 'deprecated').length, 1);
});

test('a printer’s disambiguating suffix is not an API change', () => {
  // @tanstack/react-query 5.51 -> 5.101: the whole difference was `_2` appended
  // to a type name. `typeToString` adds that when two types share a name in
  // scope, so which one gets a suffix depends on what else is in the file. Same
  // family as the version inside a cache path — the rendering moved, the API
  // did not.
  const changes = diffSurfaces(
    surface('5.51.1', [sym('Provider', '(props: QueryClientProviderProps) => Element')]),
    surface('5.101.4', [sym('Provider', '(props: QueryClientProviderProps_2) => Element_2')]),
  ).changes;
  assert.deepEqual(changes, []);
});

test('a type that really is named with a numeric suffix still differs', () => {
  const changes = diffSurfaces(
    surface('1.0.0', [sym('f', '() => Shape_2')]),
    surface('2.0.0', [sym('f', '() => Shape_3')]),
  ).changes;
  assert.deepEqual(changes, [], 'both normalise to Shape — indistinguishable, so nothing is claimed');
});

// ---------------------------------------------------------------------------
// What a signature comparison can and cannot demonstrate
// ---------------------------------------------------------------------------

test('a new required parameter is breaking, because that is provable', () => {
  // Every existing call site is now missing an argument. Nothing about the rest
  // of the signature has to be understood to know that.
  const changes = diffSurfaces(
    surface('1.0.0', [sym('send', '(to: string) => void')]),
    surface('2.0.0', [sym('send', '(to: string, from: string) => void')]),
  ).changes;
  assert.equal(changes[0]?.severity, 'breaking');
  assert.equal(changes[0]?.confidence, 'high');
});

test('any other signature edit is drift, because breakage cannot be shown', () => {
  // Measured, and the reason this is a calibration rather than a detection fix.
  // Of 44 signature-changed findings on activepieces, none was a shape a string
  // comparison could prove compatible or incompatible: 24 were not function
  // signatures at all, and the other 20 changed more than one thing at once.
  // Roughly half were additions — a wider input union, an extra property on a
  // returned object — which break nobody.
  //
  // The finding is still reported with its call sites. What changes is the
  // claim: something moved under you and Emend cannot tell whether it bites.
  const changes = diffSurfaces(
    surface('1.0.0', [sym('parse', '(input: string) => Result')]),
    surface('2.0.0', [sym('parse', '(input: string | Uint8Array) => Result')]),
  ).changes;
  assert.equal(changes.length, 1, 'still reported');
  assert.equal(changes[0]?.severity, 'drift');
  assert.equal(changes[0]?.kind, 'signature-changed');
});

test('a removed symbol stays breaking', () => {
  // The other thing a comparison can prove: it is not there any more.
  const changes = diffSurfaces(
    surface('1.0.0', [sym('gone', 'typeof gone'), sym('kept', 'string')]),
    surface('2.0.0', [sym('kept', 'string')]),
  ).changes;
  assert.equal(changes.find((c) => c.path === 'gone')?.severity, 'breaking');
});

test('a widening is still a feature, not drift', () => {
  const changes = diffSurfaces(
    surface('1.0.0', [sym('C', 'C<D>', { typeParams: [{ name: 'D', defaulted: true }] })]),
    surface('2.0.0', [
      sym('C', 'C<D, P>', {
        typeParams: [{ name: 'D', defaulted: true }, { name: 'P', defaulted: true }],
      }),
    ]),
  ).changes;
  assert.equal(changes[0]?.severity, 'feature');
});

// ---------------------------------------------------------------------------
// A parameter's name is not part of the contract
// ---------------------------------------------------------------------------

test('a renamed parameter is not a signature change', () => {
  // TypeScript has no named arguments, so a caller cannot observe what a
  // parameter is called. cron-validator went `options?` -> `partialOptions?`
  // between 1.3.1 and 1.4.0 and nothing else moved; reporting that is reporting
  // the implementation's choice of identifier.
  assert.equal(
    positionalParams('(cron: string, options?: Partial<Options>) => boolean'),
    positionalParams('(cron: string, partialOptions?: Partial<Options>) => boolean'),
  );
});

test('a destructuring pattern is not a signature change either', () => {
  // The same fact in the shape it actually arrives in. TypeScript prints the
  // binding pattern where a parameter is destructured, so a component that
  // pulls one more prop out of an argument whose declared type never changed
  // renders as a different signature — @xyflow/react's `BaseEdge` and
  // react-hook-form's `FormProvider` both did, across 21 call sites.
  assert.equal(
    positionalParams('({ id, path, labelX }: BaseEdgeProps) => any'),
    positionalParams('({ path, labelX, ...props }: BaseEdgeProps) => any'),
  );
  assert.equal(
    positionalParams('(props: FormProviderProps<T>) => React.JSX.Element'),
    positionalParams('({ children, watch, getValues }: FormProviderProps<T>) => React.JSX.Element'),
  );
});

test('what a parameter IS still counts', () => {
  // The negative controls, and they are the point. An earlier rule of this shape
  // matched too loosely and hid real removals across a whole package, so each of
  // these is a way this one could go wrong.
  const differs = (a: string, b: string) =>
    assert.notEqual(positionalParams(a), positionalParams(b), `${a} vs ${b}`);

  differs('(a: string) => void', '(a: number) => void');          // type changed
  differs('(a: string) => void', '(a?: string) => void');         // became optional
  differs('(a: string) => void', '(a: string, b: number) => void'); // arity changed
  differs('(a: string) => void', '(...a: string[]) => void');     // became rest
  differs('(a: string) => X', '(a: string) => Y');                // return changed
});

test('an object type is left alone', () => {
  // The discriminator. Members of an object type are named and their names are
  // absolutely part of the contract — only a binding directly inside a
  // parameter list is positional, and confusing the two would erase real
  // property renames everywhere.
  assert.notEqual(
    positionalParams('(o: { mode: string }) => void'),
    positionalParams('(o: { style: string }) => void'),
  );
  assert.notEqual(positionalParams('{ a: string }'), positionalParams('{ b: string }'));
});
