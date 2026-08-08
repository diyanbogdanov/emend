import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, tools } from '../src/mcp.ts';

const call = (method: string, params?: Record<string, unknown>) =>
  handle({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) });

// ---------------------------------------------------------------------------
// The handshake
// ---------------------------------------------------------------------------

test('initialize answers with the protocol version and tool capability', async () => {
  const r = (await call('initialize')) as { result: Record<string, unknown> };
  assert.equal(r.result['protocolVersion'], '2024-11-05');
  assert.deepEqual(r.result['capabilities'], { tools: {} });
});

test('a notification draws no response at all', async () => {
  // Notifications carry no id. Replying to one is a protocol error that some
  // clients treat as fatal, and it is the easiest thing to get wrong when the
  // transport is a loop over lines.
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

test('an unknown method is a protocol error, not a tool error', async () => {
  const r = (await call('nonsense/method')) as { error?: { code: number } };
  assert.equal(r.error?.code, -32601);
});

// ---------------------------------------------------------------------------
// What the agent is offered
// ---------------------------------------------------------------------------

test('every tool advertises a schema the caller can satisfy', async () => {
  const r = (await call('tools/list')) as { result: { tools: Array<Record<string, unknown>> } };
  assert.ok(r.result.tools.length >= 7, 'the primitives are all offered');
  for (const t of r.result.tools) {
    assert.ok(typeof t['name'] === 'string' && (t['name'] as string).length > 0);
    assert.ok((t['description'] as string).length > 40, `${t['name']} needs a usable description`);
    const schema = t['inputSchema'] as Record<string, unknown>;
    assert.equal(schema['type'], 'object');
    assert.ok(Array.isArray(schema['required']), `${t['name']} must say what it requires`);
  }
});

test('the advisory check is offered separately from the fix', async () => {
  // The distinction the whole vulnerability path rests on. If an agent can only
  // ask "did it build", it will report a green build with the vulnerable version
  // still installed as a fix — which is the failure most easily mistaken for
  // success, and moving the loop out of Emend must not move that check out too.
  const names = tools().map((t) => t.name);
  assert.ok(names.includes('advisory_status'));
  assert.ok(names.includes('verify'));
  const fix = tools().find((t) => t.name === 'fix_vulnerability');
  assert.match(fix?.description ?? '', /SEPARATELY/);
});

// ---------------------------------------------------------------------------
// Failure reaches the agent in a form it can act on
// ---------------------------------------------------------------------------

test('an unknown tool is reported to the agent, not thrown at the transport', async () => {
  const r = (await call('tools/call', { name: 'no_such_tool', arguments: {} })) as {
    result: { isError: boolean; content: Array<{ text: string }> };
  };
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0]?.text ?? '', /no such tool/);
});

test('a bad argument comes back as a readable tool error', async () => {
  // Reported as a tool error rather than a protocol error precisely so the agent
  // can read it, correct itself and call again — which a transport failure would
  // not let it do.
  const r = (await call('tools/call', { name: 'scan', arguments: {} })) as {
    result: { isError: boolean; content: Array<{ text: string }> };
  };
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0]?.text ?? '', /repo is required/);
});

test('a tool result is JSON the agent can parse, not prose', async () => {
  const r = (await call('tools/call', {
    name: 'advisory_status',
    arguments: { repo: process.cwd(), pkg: 'typescript' },
  })) as { result: { content: Array<{ text: string }> } };
  const parsed = JSON.parse(r.result.content[0]?.text ?? '{}') as Record<string, unknown>;
  assert.equal(parsed['pkg'], 'typescript');
  assert.ok(Array.isArray(parsed['installed']));
});
