import test from 'node:test';
import assert from 'node:assert/strict';
import { missingSymbols } from '../src/fix.ts';
import { nearbySymbols } from '../src/llm/propose.ts';

// The exact text tsc produced on the live axios run.
const AXIOS = `src/client.ts(1,52): error TS2614: Module '"axios"' has no exported member 'AxiosTransformer'. Did you mean to use 'import AxiosTransformer from "axios"' instead?
src/client.ts(12,45): error TS7006: Parameter 'data' implicitly has an 'any' type.`;

function symbols(names: string[]): Record<string, { path: string; deprecated: boolean }> {
  return Object.fromEntries(names.map((n) => [n, { path: n, deprecated: false }]));
}

// ---------------------------------------------------------------------------
// What the compiler says has gone
// ---------------------------------------------------------------------------

test('a removed export is read out of the error that reports it', () => {
  // The candidate list is ranked by similarity to the symbols that BROKE. On a
  // vulnerability repair there are no drift findings to supply those, so the
  // compiler output is the only source, and this is where it says them.
  assert.deepEqual(missingSymbols(AXIOS), ['AxiosTransformer']);
});

test('the other ways a symbol goes missing are read too', () => {
  assert.deepEqual(
    missingSymbols(`a.ts(1,1): error TS2304: Cannot find name 'ListLogSummary'.`),
    ['ListLogSummary'],
  );
  assert.deepEqual(
    missingSymbols(`a.ts(2,3): error TS2339: Property 'silent' does not exist on type 'SimpleGit'.`),
    ['silent'],
  );
});

test('a name is reported once however many call sites broke on it', () => {
  const repeated = `a.ts(1,1): error TS2304: Cannot find name 'Foo'.
b.ts(9,2): error TS2304: Cannot find name 'Foo'.`;
  assert.deepEqual(missingSymbols(repeated), ['Foo']);
});

test('an error about something still present names nothing missing', () => {
  // Type mismatches and arity errors are about symbols that exist. Feeding them
  // in would rank the candidate list by similarity to a name that is not the
  // problem, which is worse than not ranking it at all.
  assert.deepEqual(
    missingSymbols(`a.ts(6,15): error TS2554: Expected 2 arguments, but got 1.`),
    [],
  );
  assert.deepEqual(missingSymbols(''), []);
});

// ---------------------------------------------------------------------------
// The whole point: does the answer reach the prompt
// ---------------------------------------------------------------------------

test('the replacement axios actually exports is offered to the model', () => {
  // The live failure, end to end. Before this, `symbolsNamedInErrors` was the
  // only candidate source on a vulnerability repair — and it matches names the
  // error mentions AGAINST the new version, so a removed symbol matches nothing
  // and the replacement was never named. The agent dropped the annotation
  // instead of using the type the package offered.
  const available = symbols([
    'AxiosAdapter',
    'AxiosBasicCredentials',
    'AxiosRequestTransformer',
    'AxiosResponseTransformer',
    'CancelTokenSource',
  ]);
  const offered = missingSymbols(AXIOS).flatMap((name) => nearbySymbols(name, available));
  assert.ok(offered.length > 0, 'a removed symbol must produce candidates');
  assert.ok(
    offered.indexOf('AxiosResponseTransformer') < offered.indexOf('AxiosAdapter'),
    `the real replacement must outrank unrelated exports; got ${JSON.stringify(offered)}`,
  );
});
