import test from 'node:test';
import assert from 'node:assert/strict';
import { stripParameterAny } from '../src/fix.ts';

test('removes a parameter any so the contextual type is inferred instead', () => {
  // recharts 3 widened the Tooltip formatter parameter. `(value: any)` compiles
  // and discards the check; removing the annotation lets TypeScript infer the
  // real contract, which is what the project had before the upgrade.
  const { text, removed } = stripParameterAny(
    'formatter={(value: any) => [`${(value ?? 0).toFixed(1)}%`, LABEL]}',
  );
  assert.equal(removed, 1);
  assert.match(text, /\(value\) =>/);
});

test('leaves a variable annotation alone', () => {
  // `const x: any = …` is not recoverable by deletion: without the annotation
  // TypeScript infers from the initialiser, which is a different type, not the
  // contextual one. Only parameters get their type back for free.
  const { text, removed } = stripParameterAny('const cache: any = {};');
  assert.equal(removed, 0);
  assert.equal(text, 'const cache: any = {};');
});

test('handles rest and optional parameters, and leaves other annotations', () => {
  const { text, removed } = stripParameterAny(
    'function f(a: any, b: string, c?: any, ...rest: any) {}',
  );
  assert.equal(removed, 3);
  assert.match(text, /b: string/);
  assert.match(text, /\(a, b: string, c\?, \.\.\.rest\)/);
});

test('does not touch any[] , which is a different type', () => {
  const { removed } = stripParameterAny('function f(xs: any[]) {}');
  assert.equal(removed, 0);
});
