import test from 'node:test';
import assert from 'node:assert/strict';
import { stripParameterAny } from '../src/fix.ts';
import {
  buildTighteningPrompt,
  TIGHTENING_SYSTEM_PROMPT,
  type TighteningContext,
} from '../src/llm/prompts.ts';

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

function tighteningContext(sources: Map<string, string>, errors: string): TighteningContext {
  return {
    finding: {
      id: 'f1',
      detector: 'npm-surface',
      pkg: 'recharts',
      fromVersion: '2.15.0',
      toVersion: '3.10.1',
      change: {
        path: 'Tooltip.formatter',
        kind: 'signature-changed',
        severity: 'breaking',
        confidence: 'medium',
        before: '(value: TValue, ...) => ReactNode',
        after: '(value: ValueType | undefined, ...) => ReactNode',
      },
      sites: [],
      confidence: 'medium',
    },
    sources,
    errors,
  };
}

test('the tightening prompt describes the sources as already stripped', () => {
  // The bug this replaces: tightening reused `previousAttempt`, which appends
  // "the source shown above is the ORIGINAL, unmodified file". By that point the
  // annotations are gone from disk, so a model trusting it copies `find` strings
  // like `(value: any)` that no longer exist. Every edit is then rejected as
  // absent and the step reports nothing — indistinguishable from a model that
  // simply declined.
  const prompt = buildTighteningPrompt(
    tighteningContext(
      new Map([['src/Chart.tsx', 'formatter={(value) => value.toFixed(1)}']]),
      "error TS2339: Property 'toFixed' does not exist on type 'ValueType'.",
    ),
  );
  assert.match(prompt, /CURRENT state, annotations already removed/);
  assert.doesNotMatch(prompt, /ORIGINAL, unmodified/);
});

test('the tightening prompt carries the compiler output and the source', () => {
  const prompt = buildTighteningPrompt(
    tighteningContext(
      new Map([['src/Chart.tsx', 'const marker = 42;']]),
      'error TS18048: my-unique-error',
    ),
  );
  assert.match(prompt, /my-unique-error/);
  assert.match(prompt, /const marker = 42;/);
  assert.match(prompt, /src\/Chart\.tsx/);
});

test('tightening is instructed to narrow rather than re-annotate', () => {
  assert.match(TIGHTENING_SYSTEM_PROMPT, /NEVER re-add a parameter type annotation/);
  assert.match(TIGHTENING_SYSTEM_PROMPT, /typeof value === 'number'/);
  assert.match(TIGHTENING_SYSTEM_PROMPT, /NEVER use a type assertion/);
  // Body edits are forbidden by the migration prompt and required by this one.
  assert.match(TIGHTENING_SYSTEM_PROMPT, /Editing the function BODY is exactly what this task requires/);
});

test('tightening rules out both disguises of blanket coercion', () => {
  // Measured, not assumed. With only a soft "prefer narrowing", the model
  // returned `Number(value ?? 0).toFixed(1)` — compiles, and silently renders a
  // real string as "0". Naming that as unacceptable produced a `typeof` guard,
  // but with `Number(value)` in the else branch, which renders "NaN" instead.
  // Both sentences below bought a measured behaviour change; neither is decoration.
  assert.match(TIGHTENING_SYSTEM_PROMPT, /Blanket coercion such as .* is NOT acceptable/);
  assert.match(TIGHTENING_SYSTEM_PROMPT, /Do not funnel it back through/);
});
