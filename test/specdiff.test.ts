import test from 'node:test';
import assert from 'node:assert/strict';
import { diffSpecs, makeDeref } from '../src/specdiff.ts';

function spec(paths: Record<string, unknown>, components?: Record<string, unknown>): string {
  return JSON.stringify({
    openapi: '3.0.0',
    info: { title: 'Acme', version: '1' },
    paths,
    ...(components ? { components } : {}),
  });
}

function param(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, in: 'query', required: false, schema: { type: 'string' }, ...over };
}

const CHARGES = {
  '/v1/charges': {
    post: { parameters: [param('amount', { required: true }), param('currency')] },
    get: { parameters: [] },
  },
};

function changed(before: string, after: string) {
  return diffSpecs('acme.com', before, after).changes;
}

// ---------------------------------------------------------------------------
// The detector cannot manufacture work
// ---------------------------------------------------------------------------

test('a spec compared with itself yields nothing', () => {
  // The rule every detector here is held to: no drift means no finding. A diff
  // that reports something against an identical input cannot be trusted to
  // report nothing against a real one.
  assert.deepEqual(changed(spec(CHARGES), spec(CHARGES)), []);
});

test('a spec that cannot be read is said to be unreadable, not clean', () => {
  // The distinction the whole product turns on. "I could not check" and "I
  // checked and it is fine" are different answers, and only one of them is safe
  // to render as a green tick.
  const result = diffSpecs('acme.com', '<html>nope</html>', spec(CHARGES));
  assert.equal(result.unanalyzable, true);
  assert.deepEqual(result.changes, []);
  assert.match(result.note ?? '', /could not be read/i);
});

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

test('an endpoint that is gone is breaking', () => {
  const after = spec({ '/v1/payment_intents': { post: { parameters: [] } } });
  const gone = changed(spec(CHARGES), after).find((c) => c.path === 'POST /v1/charges');
  assert.equal(gone?.kind, 'removed');
  assert.equal(gone?.severity, 'breaking');
  assert.equal(gone?.confidence, 'high');
});

test('one method going while the path stays is still breaking', () => {
  // The path still resolving is what makes this easy to miss by hand: the URL
  // looks alive, and only that verb is gone.
  const after = spec({ '/v1/charges': { get: { parameters: [] } } });
  const found = changed(spec(CHARGES), after);
  assert.ok(found.some((c) => c.path === 'POST /v1/charges' && c.severity === 'breaking'));
  assert.ok(!found.some((c) => c.path === 'GET /v1/charges' && c.severity === 'breaking'));
});

test('a new endpoint is a feature, and is not counted against anybody', () => {
  const after = spec({ ...CHARGES, '/v1/refunds': { post: { parameters: [] } } });
  const added = changed(spec(CHARGES), after).find((c) => c.path === 'POST /v1/refunds');
  assert.equal(added?.kind, 'added');
  assert.equal(added?.severity, 'feature');
});

test('an endpoint marked deprecated is a deprecation, not a break', () => {
  // It still works. Reporting it as breaking would put a false number on the
  // one line of a scan that people actually read.
  const after = spec({
    '/v1/charges': { post: { deprecated: true, parameters: CHARGES['/v1/charges'].post.parameters }, get: { parameters: [] } },
  });
  const dep = changed(spec(CHARGES), after).find((c) => c.path === 'POST /v1/charges');
  assert.equal(dep?.kind, 'deprecated');
  assert.equal(dep?.severity, 'deprecation');
});

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

test('a newly required parameter is breaking, because existing calls omit it', () => {
  const after = spec({
    '/v1/charges': {
      post: { parameters: [param('amount', { required: true }), param('currency'), param('idempotency_key', { required: true })] },
      get: { parameters: [] },
    },
  });
  const req = changed(spec(CHARGES), after).find((c) => c.path.includes('idempotency_key'));
  assert.equal(req?.severity, 'breaking');
  assert.equal(req?.kind, 'signature-changed');
});

test('a newly optional parameter is not breaking, because nothing has to change', () => {
  const after = spec({
    '/v1/charges': {
      post: { parameters: [param('amount', { required: true }), param('currency'), param('description')] },
      get: { parameters: [] },
    },
  });
  const opt = changed(spec(CHARGES), after).find((c) => c.path.includes('description'));
  assert.equal(opt?.severity, 'feature');
});

test('an existing parameter becoming required is breaking', () => {
  // The change with no visible edit: the call site is byte-for-byte what it was
  // and the request it sends is now incomplete.
  const after = spec({
    '/v1/charges': {
      post: { parameters: [param('amount', { required: true }), param('currency', { required: true })] },
      get: { parameters: [] },
    },
  });
  const tightened = changed(spec(CHARGES), after).find((c) => c.path.includes('currency'));
  assert.equal(tightened?.severity, 'breaking');
  assert.equal(tightened?.before, 'optional');
  assert.equal(tightened?.after, 'required');
});

test('a parameter that changed type is breaking', () => {
  // Self-contained rather than built off CHARGES, so the two sides differ in
  // exactly one thing and the assertion cannot pass for another reason.
  const one = (type: string): string =>
    spec({
      '/v1/charges': {
        post: { parameters: [param('amount', { required: true, schema: { type } })] },
      },
    });
  const retyped = changed(one('integer'), one('string')).find((c) => c.path.includes('amount'));
  assert.equal(retyped?.severity, 'breaking');
  assert.equal(retyped?.before, 'integer');
  assert.equal(retyped?.after, 'string');
});

test('a parameter that disappeared is reported, but only at medium confidence', () => {
  // Servers differ. Most ignore an unknown query parameter; strict ones reject
  // the request outright. Emend cannot tell which from the description alone, so
  // it reports the change and declines to be certain about the consequence.
  const after = spec({
    '/v1/charges': { post: { parameters: [param('amount', { required: true })] }, get: { parameters: [] } },
  });
  const dropped = changed(spec(CHARGES), after).find((c) => c.path.includes('currency'));
  assert.equal(dropped?.kind, 'removed');
  assert.equal(dropped?.confidence, 'medium');
});

// ---------------------------------------------------------------------------
// $ref
// ---------------------------------------------------------------------------

test('a diff sees through local $refs, which real specs are mostly made of', () => {
  // Without this the diff is not merely incomplete, it is silently empty:
  // Stripe's description defines almost everything under `components` and
  // references it. Returning no changes there would read as "checked, and fine".
  const before = spec(
    { '/v1/charges': { post: { parameters: [{ $ref: '#/components/parameters/Currency' }] } } },
    { parameters: { Currency: param('currency') } },
  );
  const after = spec(
    { '/v1/charges': { post: { parameters: [{ $ref: '#/components/parameters/Currency' }] } } },
    { parameters: { Currency: param('currency', { required: true }) } },
  );
  const tightened = changed(before, after).find((c) => c.path.includes('currency'));
  assert.equal(tightened?.severity, 'breaking');
});

test('a $ref that points nowhere is left alone rather than invented', () => {
  const doc = { paths: {}, components: {} };
  const node = { $ref: '#/components/schemas/Missing' };
  assert.deepEqual(makeDeref(doc)(node), node);
});

test('a $ref cycle terminates instead of hanging', () => {
  // Self-referential schemas are ordinary — a tree node whose children are the
  // same type. An unguarded resolver walks that forever.
  const doc = {
    components: { schemas: { A: { $ref: '#/components/schemas/B' }, B: { $ref: '#/components/schemas/A' } } },
  };
  assert.ok(makeDeref(doc)({ $ref: '#/components/schemas/A' }), 'resolution completed');
});

test('a description whose refs are shared many times over does not explode', () => {
  // Measured, and fatal: inlining every `$ref` ran the real 8MB Stripe
  // description out of memory, because a shared schema referenced hundreds of
  // times is copied hundreds of times, and each copy contains more references.
  //
  // This fixture is that shape in miniature — each level names the one below it
  // twice, so full inlining is 2^n and lazy resolution is n. Twenty-five levels
  // is 33 million nodes one way and twenty-five the other.
  const schemas: Record<string, unknown> = { L0: { type: 'string' } };
  for (let i = 1; i <= 25; i++) {
    schemas[`L${i}`] = {
      type: 'object',
      properties: {
        a: { $ref: `#/components/schemas/L${i - 1}` },
        b: { $ref: `#/components/schemas/L${i - 1}` },
      },
    };
  }
  const body = spec(
    {
      '/v1/things': {
        post: {
          parameters: [{ name: 'thing', in: 'query', required: true, schema: { $ref: '#/components/schemas/L25' } }],
        },
      },
    },
    { schemas },
  );

  const started = process.hrtime.bigint();
  const result = diffSpecs('acme.com', body, body);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(result.unanalyzable, false);
  assert.deepEqual(result.changes, []);
  assert.ok(elapsedMs < 2000, `resolution stayed linear (took ${elapsedMs}ms)`);
});

test('a parameter behind a $ref is still compared through it', () => {
  // The lazy resolution above must not become no resolution: the reference is
  // followed where the diff actually looks.
  const one = (required: boolean): string =>
    spec(
      { '/v1/charges': { post: { parameters: [{ $ref: '#/components/parameters/Currency' }] } } },
      { parameters: { Currency: param('currency', { required }) } },
    );
  const tightened = changed(one(false), one(true)).find((c) => c.path.includes('currency'));
  assert.equal(tightened?.severity, 'breaking');
});

test('a parameter schema behind a $ref is compared through it too', () => {
  const one = (type: string): string =>
    spec(
      { '/v1/charges': { post: { parameters: [param('amount', { schema: { $ref: '#/components/schemas/Amount' } })] } } },
      { schemas: { Amount: { type } } },
    );
  const retyped = changed(one('integer'), one('string')).find((c) => c.path.includes('amount'));
  assert.equal(retyped?.before, 'integer');
  assert.equal(retyped?.after, 'string');
});

test('an external $ref is left as it is, since the file it names was never fetched', () => {
  const node = { $ref: 'https://elsewhere.example/spec.json#/x' };
  assert.deepEqual(makeDeref({})(node), node);
});
