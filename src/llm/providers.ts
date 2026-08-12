/**
 * Provider presets for open-weight model hosts.
 *
 * Every provider here speaks the OpenAI chat-completions protocol, so this is
 * one adapter parameterised by base URL and key, not seven integrations. That
 * also means a self-hosted vLLM or Ollama endpoint is a first-class option — no
 * code change, just a different base URL.
 *
 * Where a provider's catalogue has been verified, it carries ONE default model
 * rather than a list of peers. An earlier version shipped three unranked
 * suggestions per provider and nothing read them, so whoever opened the file
 * picked the first line — which by then was a generation old and measurably
 * worse at the tightening pass. One ranked, dated, overridable default is
 * honest about which choice is actually recommended; an unranked list is not.
 *
 * The frontier still moves monthly, so a default here is a starting point with
 * a shelf life, not a pin. `EMEND_LLM_MODEL` overrides it, `emend models` lists
 * what your provider serves today, and docs/deployment.md records when the
 * recommendation was last measured and against what.
 */

export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  /** Environment variables checked, in order, for the API key. */
  keyEnv: string[];
  /** Documentation pointer shown when the key is missing. */
  docs: string;
  /**
   * Used when `EMEND_LLM_MODEL` is unset. Only set where the ID has actually
   * been confirmed against the provider's catalogue — a guessed ID fails at the
   * first request with a 404 that reads like a bug in Emend. Providers whose
   * catalogue needs a key to read are left without one on purpose: their users
   * get the "set EMEND_LLM_MODEL" error, which is honest.
   */
  defaultModel?: string;
  /** Some local runtimes accept any key value. */
  keyOptional?: boolean;
}

export const PROVIDERS: Record<string, ProviderPreset> = {
  nebius: {
    id: 'nebius',
    label: 'Nebius Token Factory',
    baseUrl: 'https://api.tokenfactory.nebius.com/v1',
    keyEnv: ['NEBIUS_API_KEY', 'EMEND_LLM_API_KEY'],
    docs: 'https://docs.tokenfactory.nebius.com/',
  },
  fireworks: {
    id: 'fireworks',
    label: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    keyEnv: ['FIREWORKS_API_KEY', 'EMEND_LLM_API_KEY'],
    docs: 'https://docs.fireworks.ai/tools-sdks/openai-compatibility',
  },
  together: {
    id: 'together',
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    keyEnv: ['TOGETHER_API_KEY', 'EMEND_LLM_API_KEY'],
    docs: 'https://docs.together.ai/docs/openai-api-compatibility',
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyEnv: ['GROQ_API_KEY', 'EMEND_LLM_API_KEY'],
    docs: 'https://console.groq.com/docs/openai',
  },
  deepinfra: {
    id: 'deepinfra',
    label: 'DeepInfra',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    keyEnv: ['DEEPINFRA_API_KEY', 'EMEND_LLM_API_KEY'],
    docs: 'https://deepinfra.com/docs/openai_api',
    // Confirmed present in DeepInfra's public catalogue on 2026-08-06.
    defaultModel: 'zai-org/GLM-5.2',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    // Both spellings are in circulation; accept either rather than failing with
    // "no API key found" at someone holding a perfectly good key.
    keyEnv: ['OPENROUTER_API_KEY', 'OPEN_ROUTER_API_KEY', 'EMEND_LLM_API_KEY'],
    docs: 'https://openrouter.ai/docs/quickstart',
    // Measured 2026-08-06 against kimi-k3, deepseek-v4-pro and qwen3-coder on the
    // recharts 3 tooltip migration: GLM-5.2 and deepseek-v4-pro both produced the
    // correctly narrowed edit, qwen3-coder did not, and kimi-k3 matched at 6x the
    // price. See docs/deployment.md for the table.
    defaultModel: 'z-ai/glm-5.2',
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    keyEnv: ['EMEND_LLM_API_KEY'],
    docs: 'https://github.com/ollama/ollama/blob/main/docs/openai.md',
    keyOptional: true,
  },
  vllm: {
    id: 'vllm',
    label: 'vLLM / self-hosted (local)',
    baseUrl: 'http://localhost:8000/v1',
    keyEnv: ['EMEND_LLM_API_KEY'],
    docs: 'https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html',
    keyOptional: true,
  },
};

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * Which preset answered, or empty for a bare `EMEND_LLM_BASE_URL`.
   *
   * The label is for people; this is for anything that has to name the provider
   * back to another tool. The harness needs it to write opencode's
   * `provider/model`, and deriving that from the label would mean parsing
   * prose.
   */
  providerId: string;
  providerLabel: string;
  temperature: number;
  maxRetries: number;
  /**
   * Output budget per request.
   *
   * The former 8,000 dated from when that was a typical ceiling. It is not any
   * more — GLM-5.2 allows 262,144 and DeepSeek V4 Pro 384,000 — and on a
   * six-file migration a reasoning model spent the whole 8,000 thinking and
   * returned an empty message with `finish_reason: length`. Nothing in Emend
   * ever overrode this, so the default was the effective limit everywhere.
   *
   * A cap is not a charge: tokens are billed as generated, so headroom is close
   * to free. 32,000 clears the largest edit set seen while staying under the
   * smallest ceiling among candidate models (qwen3-coder, 65,536). Lower it for
   * a local runtime that rejects large values.
   */
  maxTokens: number;
}

export interface LlmConfigError {
  ok: false;
  reason: string;
}

export type LlmConfigResult = { ok: true; config: LlmConfig } | LlmConfigError;

/**
 * Read a numeric setting from the environment, or explain why it cannot be.
 *
 * `Number('lots')` is `NaN`, and `JSON.stringify` renders `NaN` as `null` — so
 * an unvalidated knob reaches the provider as `"max_tokens": null` and a typo
 * looks like a bug in Emend. Every numeric setting goes through here, and a bad
 * one is reported exactly the way a missing API key is.
 */
function numericEnv(
  name: string,
  fallback: number,
  min: number,
): { ok: true; value: number } | LlmConfigError {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return { ok: true, value: fallback };
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    return { ok: false, reason: `${name}="${raw}" is not a number >= ${min}.` };
  }
  return { ok: true, value };
}

/**
 * Resolve LLM configuration from the environment.
 *
 * Returns a structured failure rather than throwing: the agent layer is
 * optional, and Emend must stay fully functional without it.
 */
export function resolveLlmConfig(overrides: Partial<{
  provider: string;
  model: string;
  baseUrl: string;
}> = {}): LlmConfigResult {
  const providerId = overrides.provider ?? process.env.EMEND_LLM_PROVIDER ?? '';
  const explicitBase = overrides.baseUrl ?? process.env.EMEND_LLM_BASE_URL;
  let model = overrides.model ?? process.env.EMEND_LLM_MODEL ?? '';

  let baseUrl = explicitBase;
  let keyEnv = ['EMEND_LLM_API_KEY'];
  let label = 'custom OpenAI-compatible endpoint';
  let keyOptional = false;

  if (providerId) {
    const preset = PROVIDERS[providerId];
    if (!preset) {
      return {
        ok: false,
        reason: `unknown provider "${providerId}". Known: ${Object.keys(PROVIDERS).join(', ')}`,
      };
    }
    baseUrl = explicitBase ?? preset.baseUrl;
    keyEnv = preset.keyEnv;
    label = preset.label;
    keyOptional = preset.keyOptional ?? false;
    // Only when nothing was asked for. An explicit choice always wins, including
    // an explicit choice that turns out to be worse than the default.
    if (!model) model = preset.defaultModel ?? '';
  }

  if (!baseUrl) {
    return {
      ok: false,
      reason:
        'no LLM configured. Set EMEND_LLM_PROVIDER (nebius, fireworks, together, groq, deepinfra, openrouter, ollama, vllm) or EMEND_LLM_BASE_URL.',
    };
  }
  if (!model) {
    // Reached only for providers with no verified default, or a custom base URL.
    // Naming the ones that do have a default turns a dead end into a next step.
    const withDefaults = Object.values(PROVIDERS)
      .filter((p) => p.defaultModel)
      .map((p) => `${p.id} (${p.defaultModel})`)
      .join(', ');
    return {
      ok: false,
      reason:
        'EMEND_LLM_MODEL is not set and this provider has no verified default. ' +
        `Run \`emend models\` to list what it serves, or use a provider that ships one: ${withDefaults}.`,
    };
  }

  let apiKey = '';
  for (const name of keyEnv) {
    const v = process.env[name];
    if (v) {
      apiKey = v;
      break;
    }
  }
  if (!apiKey && !keyOptional) {
    return { ok: false, reason: `no API key found. Set one of: ${keyEnv.join(', ')}` };
  }

  const temperature = numericEnv('EMEND_LLM_TEMPERATURE', 0, 0);
  if (!temperature.ok) return temperature;
  const maxRetries = numericEnv('EMEND_LLM_MAX_ATTEMPTS', 3, 1);
  if (!maxRetries.ok) return maxRetries;
  const maxTokens = numericEnv('EMEND_LLM_MAX_TOKENS', 32_000, 1);
  if (!maxTokens.ok) return maxTokens;

  return {
    ok: true,
    config: {
      baseUrl: baseUrl.replace(/\/+$/, ''),
      apiKey: apiKey || 'not-needed',
      model,
      providerId,
      providerLabel: label,
      temperature: temperature.value,
      maxRetries: maxRetries.value,
      maxTokens: maxTokens.value,
    },
  };
}

/**
 * Whether the model takes part in a run, and if not, whose decision that was.
 *
 * Three states rather than two, because the two that used to exist could not
 * express the interesting one. `--agent` was opt-in, so a run without it and a
 * run whose key was missing produced the same output: fewer fixes, no
 * explanation. A reader cannot tell a tool that chose not to try from a tool
 * that could not.
 */
export type AgentAvailability =
  | { on: true; config: LlmConfig }
  /** The operator asked for a deterministic run. Nothing to report. */
  | { on: false; why: 'disabled'; reason?: undefined }
  /** The model was wanted and could not be reached. Say how to fix it. */
  | { on: false; why: 'unconfigured'; reason: string };

/**
 * Resolve the model for a run, defaulting to using one.
 *
 * On by default because the alternative undersells what Emend is for: a finding
 * the deterministic planner declines is a finding somebody repairs by hand, and
 * a self-maintaining tool that stops at the mechanical cases is a linter that
 * files issues. `disabled` exists for runs that must stay offline or byte-for-byte
 * reproducible, which is a real need and a deliberate one.
 */
export function resolveAgent(
  options: { disabled?: boolean },
  overrides: Partial<{ provider: string; model: string; baseUrl: string }> = {},
): AgentAvailability {
  if (options.disabled === true) return { on: false, why: 'disabled' };
  const resolved = resolveLlmConfig(overrides);
  return resolved.ok
    ? { on: true, config: resolved.config }
    : { on: false, why: 'unconfigured', reason: resolved.reason };
}
