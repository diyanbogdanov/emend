import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, resolveAgent, resolveLlmConfig } from '../src/llm/providers.ts';

const TOUCHED = [
  'EMEND_LLM_PROVIDER',
  'EMEND_LLM_MODEL',
  'EMEND_LLM_BASE_URL',
  'EMEND_LLM_API_KEY',
  'EMEND_LLM_MAX_TOKENS',
  'EMEND_LLM_TEMPERATURE',
  'EMEND_LLM_MAX_ATTEMPTS',
  'OPENROUTER_API_KEY',
  'OPEN_ROUTER_API_KEY',
  'GROQ_API_KEY',
  'DEEPINFRA_API_KEY',
];

/** Runs `fn` with only the given LLM env vars set, then restores the environment. */
function withEnv(vars: Record<string, string>, fn: () => void): void {
  const saved = new Map(TOUCHED.map((k) => [k, process.env[k]]));
  for (const k of TOUCHED) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    fn();
  } finally {
    for (const k of TOUCHED) delete process.env[k];
    for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
  }
}

test('a provider with a verified default needs no EMEND_LLM_MODEL', () => {
  // Without this, setting a provider and a key still failed with "model is not
  // set" — and the user then picked from several hundred models with no
  // guidance, which is exactly how a generation-old model got chosen before.
  withEnv({ OPENROUTER_API_KEY: 'test-key' }, () => {
    const res = resolveLlmConfig({ provider: 'openrouter' });
    assert.equal(res.ok, true);
    assert.equal(res.ok && res.config.model, 'z-ai/glm-5.2');
  });
});

test('EMEND_LLM_MODEL always beats the default', () => {
  // The default is a starting point with a shelf life, not a pin. A user who has
  // measured something better for their codebase must not be overridden by it.
  withEnv({ OPENROUTER_API_KEY: 'test-key', EMEND_LLM_MODEL: 'moonshotai/kimi-k3' }, () => {
    const res = resolveLlmConfig({ provider: 'openrouter' });
    assert.equal(res.ok && res.config.model, 'moonshotai/kimi-k3');
  });
});

test('an explicit override beats both the env var and the default', () => {
  withEnv({ OPENROUTER_API_KEY: 'test-key', EMEND_LLM_MODEL: 'from/env' }, () => {
    const res = resolveLlmConfig({ provider: 'openrouter', model: 'from/argument' });
    assert.equal(res.ok && res.config.model, 'from/argument');
  });
});

test('a provider with no verified default fails, and points somewhere useful', () => {
  // Guessing an ID for a catalogue that cannot be read without a key would fail
  // at the first request with a 404 that reads like an Emend bug. Failing here
  // instead is the honest outcome, so the message has to carry a next step.
  withEnv({ GROQ_API_KEY: 'test-key' }, () => {
    const res = resolveLlmConfig({ provider: 'groq' });
    assert.equal(res.ok, false);
    assert.match(res.ok === false ? res.reason : '', /no verified default/);
    assert.match(res.ok === false ? res.reason : '', /openrouter \(z-ai\/glm-5\.2\)/);
  });
});

test('a custom base URL still requires an explicit model', () => {
  // No preset means no catalogue anyone has verified, so there is nothing to
  // default to — a self-hosted endpoint serves whatever its operator loaded.
  withEnv({ EMEND_LLM_BASE_URL: 'http://localhost:9999/v1', EMEND_LLM_API_KEY: 'k' }, () => {
    const res = resolveLlmConfig({});
    assert.equal(res.ok, false);
  });
});

test('a numeric setting that is not a number is refused, not passed on', () => {
  // `Number('lots')` is NaN, and JSON.stringify renders NaN as null — so an
  // unvalidated knob reaches the provider as `"max_tokens": null`, and a typo
  // surfaces as whatever that provider does with it. Refusing here names the
  // variable and the value instead.
  withEnv({ OPENROUTER_API_KEY: 'test-key', EMEND_LLM_MAX_TOKENS: 'lots' }, () => {
    const res = resolveLlmConfig({ provider: 'openrouter' });
    assert.equal(res.ok, false);
    assert.match(res.ok === false ? res.reason : '', /EMEND_LLM_MAX_TOKENS="lots"/);
  });
});

test('a numeric setting below its floor is refused', () => {
  // Zero attempts is not a configuration, it is a migration that never runs.
  withEnv({ OPENROUTER_API_KEY: 'test-key', EMEND_LLM_MAX_ATTEMPTS: '0' }, () => {
    const res = resolveLlmConfig({ provider: 'openrouter' });
    assert.equal(res.ok, false);
    assert.match(res.ok === false ? res.reason : '', /EMEND_LLM_MAX_ATTEMPTS/);
  });
});

test('numeric settings default when unset and are carried through when valid', () => {
  withEnv({ OPENROUTER_API_KEY: 'test-key' }, () => {
    const res = resolveLlmConfig({ provider: 'openrouter' });
    assert.equal(res.ok && res.config.maxTokens, 32_000);
    assert.equal(res.ok && res.config.maxRetries, 3);
  });
  withEnv({ OPENROUTER_API_KEY: 'test-key', EMEND_LLM_MAX_TOKENS: '120000' }, () => {
    const res = resolveLlmConfig({ provider: 'openrouter' });
    assert.equal(res.ok && res.config.maxTokens, 120_000);
  });
});

test('every declared default belongs to a provider that can be resolved', () => {
  // A typo in a defaultModel is invisible until someone runs an agent migration
  // and gets a 404. This cannot check the ID against a live catalogue, but it can
  // check that the presets carrying one are internally coherent.
  const withDefault = Object.values(PROVIDERS).filter((p) => p.defaultModel);
  assert.ok(withDefault.length > 0, 'at least one provider should ship a default');
  for (const p of withDefault) {
    assert.match(p.defaultModel ?? '', /^\S+$/, `${p.id} default must not be blank`);
    withEnv({ EMEND_LLM_API_KEY: 'test-key' }, () => {
      const res = resolveLlmConfig({ provider: p.id });
      assert.equal(res.ok, true, `${p.id} should resolve using its own default`);
    });
  }
});

// ---------------------------------------------------------------------------
// Whether the model participates at all
// ---------------------------------------------------------------------------

test('the model participates unless the operator turns it off', () => {
  // Opt-in was the wrong default. A repair Emend declines to attempt is a repair
  // somebody does by hand, and a tool that stops at the deterministic cases is a
  // linter — so the model runs, and the flag exists to switch it off.
  withEnv({ OPENROUTER_API_KEY: 'test-key' }, () => {
    const on = resolveAgent({}, { provider: 'openrouter' });
    assert.equal(on.on, true);
  });
});

test('turning the model off is distinguishable from having no key', () => {
  // These used to look identical from the outside — both simply produced fewer
  // fixes, and a run that never called a model read as a model that tried and
  // found nothing. One is a choice and the other is a broken setup, and only the
  // second is worth telling somebody how to correct.
  withEnv({ OPENROUTER_API_KEY: 'test-key' }, () => {
    const off = resolveAgent({ disabled: true }, { provider: 'openrouter' });
    assert.equal(off.on, false);
    assert.equal(off.on === false && off.why, 'disabled');
  });

  withEnv({}, () => {
    const missing = resolveAgent({}, { provider: 'openrouter' });
    assert.equal(missing.on, false);
    assert.equal(missing.on === false && missing.why, 'unconfigured');
    assert.match(missing.on === false ? (missing.reason ?? '') : '', /API key/);
  });
});
