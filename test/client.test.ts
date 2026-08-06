import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { chat } from '../src/llm/client.ts';
import type { LlmConfig } from '../src/llm/providers.ts';

/** A stub chat endpoint that replays `responses` in order, then repeats the last. */
async function stubProvider(
  responses: Array<{ status: number; body: unknown }>,
): Promise<{ config: LlmConfig; hits: () => number; close: () => Promise<void> }> {
  let hits = 0;
  const server: Server = createServer((req, res) => {
    const reply = responses[Math.min(hits, responses.length - 1)]!;
    hits++;
    req.resume();
    req.on('end', () => {
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    config: {
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: 'test',
      model: 'test-model',
      providerLabel: 'stub',
      temperature: 0,
      maxRetries: 3,
      maxTokens: 32_000,
    },
    hits: () => hits,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const GOOD = { status: 200, body: { choices: [{ message: { content: '{"edits":[]}' } }] } };
// `finish_reason` belongs to the choice, not the body — the client reads
// `choices[0].finish_reason`, so putting it alongside `choices` would leave the
// truncation branch untested against a fixture that looked like it covered it.
const EMPTY = { status: 200, body: { choices: [{ message: { content: '' }, finish_reason: 'stop' }] } };

test('an empty message is retried rather than ending the migration', async () => {
  // The failure this exists for: on a real recharts run the provider returned one
  // empty message, the agent loop treated it as terminal, and a migration that had
  // two further attempts available was abandoned with zero edits.
  const stub = await stubProvider([EMPTY, GOOD]);
  try {
    const res = await chat(stub.config, [{ role: 'user', content: 'hi' }]);
    assert.equal(res.ok, true);
    assert.equal(stub.hits(), 2, 'should have retried exactly once');
  } finally {
    await stub.close();
  }
});

test('a 5xx is retried', async () => {
  const stub = await stubProvider([{ status: 503, body: { error: 'upstream down' } }, GOOD]);
  try {
    const res = await chat(stub.config, [{ role: 'user', content: 'hi' }]);
    assert.equal(res.ok, true);
    assert.equal(stub.hits(), 2);
  } finally {
    await stub.close();
  }
});

test('a 401 is not retried, because it will not change', async () => {
  // Retrying a rejected key wastes the user's time and the provider's rate limit,
  // and buries the one error message that tells them what to fix.
  const stub = await stubProvider([{ status: 401, body: { error: { message: 'bad key' } } }]);
  try {
    const res = await chat(stub.config, [{ role: 'user', content: 'hi' }]);
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /401/);
    assert.equal(stub.hits(), 1, 'a settled answer must not be asked again');
  } finally {
    await stub.close();
  }
});

test('retries are bounded, and the last error survives', async () => {
  const stub = await stubProvider([EMPTY]);
  try {
    const res = await chat(stub.config, [{ role: 'user', content: 'hi' }]);
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /empty message/);
    assert.equal(stub.hits(), 3, 'three transport attempts, then give up');
  } finally {
    await stub.close();
  }
});

test('truncation is not retried, and says what to change', async () => {
  // The real recharts failure: a reasoning model spent the whole output budget
  // thinking and returned nothing. That is deterministic — three identical
  // requests burned the same tokens to the same end, and the reported error
  // ("empty message") pointed at the provider rather than at max_tokens.
  const stub = await stubProvider([
    { status: 200, body: { choices: [{ message: { content: '' }, finish_reason: 'length' }] } },
  ]);
  try {
    const res = await chat(stub.config, [{ role: 'user', content: 'hi' }]);
    assert.equal(res.ok, false);
    assert.equal(stub.hits(), 1, 'asking again cannot change a token budget');
    assert.match(res.error ?? '', /ran out of output tokens/);
    assert.match(res.error ?? '', /EMEND_LLM_MAX_TOKENS/);
  } finally {
    await stub.close();
  }
});
