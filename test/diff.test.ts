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
  assert.equal(changes[0]?.severity, 'breaking');
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
  assert.equal(changes[0]?.severity, 'breaking');
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
