import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSpec } from '../src/specdiff.ts';

const YAML_SPEC = `openapi: 3.0.0
info:
  title: Acme
  version: "1"
paths:
  /v1/charges:
    post:
      parameters:
        - name: amount
          in: query
          required: true
          schema:
            type: integer
`;

// ---------------------------------------------------------------------------
// Reading both forms
// ---------------------------------------------------------------------------

test('a YAML description is read, because most first-party ones are YAML', () => {
  // Stripe's own `x-origin` names `spec3.yaml`. Refusing YAML meant the best
  // pointer any directory gives us landed on a file we would not open.
  const doc = parseSpec(YAML_SPEC) as { openapi: string; paths: Record<string, unknown> };
  assert.equal(doc?.openapi, '3.0.0');
  assert.ok(doc.paths['/v1/charges']);
});

test('JSON still parses, and by the cheaper route', () => {
  const doc = parseSpec(JSON.stringify({ openapi: '3.0.0', info: {}, paths: { '/x': {} } }));
  assert.ok(doc);
});

test('YAML that describes no API is refused like JSON that describes none', () => {
  assert.equal(parseSpec('error: not found\ncode: 404\n'), null);
  assert.equal(parseSpec('- one\n- two\n'), null);
});

test('malformed YAML yields nothing rather than throwing', () => {
  // A description Emend cannot read is one it must not claim to have checked,
  // and a parser error must not take the scan down with it.
  assert.equal(parseSpec('openapi: 3.0.0\n  bad:\n indentation: [\n'), null);
  assert.equal(parseSpec(''), null);
});

test('a swagger 2.0 YAML description counts too', () => {
  assert.ok(parseSpec('swagger: "2.0"\ninfo: {}\npaths:\n  /v1/x: {}\n'));
});

// ---------------------------------------------------------------------------
// It is untrusted input
//
// These bodies come from arbitrary URLs — a directory listing, a stranger's
// repository, a CDN. YAML has three well-known ways to turn that into a problem,
// so each is asserted rather than assumed from the parser's reputation.
// ---------------------------------------------------------------------------

test('an alias bomb is refused instead of exhausting the process', () => {
  // The billion-laughs shape: each layer references the one below it nine times,
  // so expansion is exponential. Parsing it to completion is the attack.
  const layers = ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'];
  let bomb = 'openapi: "3.0.0"\npaths: {}\na: &a ["x","x","x","x","x","x","x","x","x"]';
  let prev = 'a';
  for (const k of layers) {
    bomb += `\n${k}: &${k} [${Array(9).fill(`*${prev}`).join(',')}]`;
    prev = k;
  }
  const started = process.hrtime.bigint();
  const doc = parseSpec(bomb);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(doc, null, 'refused rather than expanded');
  assert.ok(elapsedMs < 1000, `and refused quickly (took ${elapsedMs}ms)`);
});

test('a __proto__ key in a description does not reach Object.prototype', () => {
  parseSpec('openapi: "3.0.0"\npaths: {}\n__proto__:\n  polluted: yes\n');
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
});

test('a tag naming a function does not produce one', () => {
  // The old js-yaml `load` hazard. Anything tagged is data here, never
  // construction.
  const doc = parseSpec('openapi: "3.0.0"\npaths: {}\nx: !!js/function "function(){return 1}"\n') as
    | Record<string, unknown>
    | null;
  assert.notEqual(typeof doc?.['x'], 'function');
});

test('a description larger than any real one is refused before parsing', () => {
  // The cap is a guard against spending minutes on something that was never a
  // description, and it applies to YAML exactly as it does to JSON.
  assert.equal(parseSpec('openapi: "3.0.0"\npaths: {}\nx: ' + 'a'.repeat(17 * 1024 * 1024)), null);
});
