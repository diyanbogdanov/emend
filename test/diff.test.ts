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
  const from = surface('1.0.0', [sym('doThing', '(a: string) => void')]);
  const to = surface('2.0.0', []);
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
