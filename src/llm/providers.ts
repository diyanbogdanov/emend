/**
 * Provider presets for open-weight model hosts.
 *
 * Every provider here speaks the OpenAI chat-completions protocol, so this is
 * one adapter parameterised by base URL and key, not seven integrations. That
 * also means a self-hosted vLLM or Ollama endpoint is a first-class option — no
 * code change, just a different base URL.
 *
 * Model IDs are deliberately NOT pinned. The open-weight frontier moves monthly
 * (Kimi K2.7, Qwen 3.7, DeepSeek V4, GLM-5.x all landed recently), so a
 * hardcoded default would ship stale. Use `emend models` to list what your
 * provider currently serves.
 */

export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  /** Environment variables checked, in order, for the API key. */
  keyEnv: string[];
  /** Documentation pointer shown when the key is missing. */
  docs: string;
  /** Models known to suit agentic code editing. Advisory only. */
  suggested: string[];
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
    suggested: [
      'Qwen/Qwen3-Coder-480B-A35B-Instruct',
      'deepseek-ai/DeepSeek-V3-0324',
      'moonshotai/Kimi-K2-Instruct',
      'zai-org/GLM-4.6',
    ],
  },
  fireworks: {
    id: 'fireworks',
    label: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    keyEnv: ['FIREWORKS_API_KEY', 'EMEND_LLM_API_KEY'],
    docs: 'https://docs.fireworks.ai/tools-sdks/openai-compatibility',
    suggested: [
      'accounts/fireworks/models/qwen3-coder-480b-a35b-instruct',
      'accounts/fireworks/models/deepseek-v3p1',
      'accounts/fireworks/models/kimi-k2-instruct',
      'accounts/fireworks/models/glm-4p6',
    ],
  },
  together: {
    id: 'together',
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    keyEnv: ['TOGETHER_API_KEY', 'EMEND_LLM_API_KEY'],
    docs: 'https://docs.together.ai/docs/openai-api-compatibility',
    suggested: [
      'Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8',
      'deepseek-ai/DeepSeek-V3',
      'moonshotai/Kimi-K2-Instruct',
    ],
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyEnv: ['GROQ_API_KEY', 'EMEND_LLM_API_KEY'],
    docs: 'https://console.groq.com/docs/openai',
    suggested: ['moonshotai/kimi-k2-instruct', 'qwen/qwen3-32b'],
  },
  deepinfra: {
    id: 'deepinfra',
    label: 'DeepInfra',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    keyEnv: ['DEEPINFRA_API_KEY', 'EMEND_LLM_API_KEY'],
    docs: 'https://deepinfra.com/docs/openai_api',
    suggested: ['Qwen/Qwen3-Coder-480B-A35B-Instruct', 'deepseek-ai/DeepSeek-V3'],
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: ['OPENROUTER_API_KEY', 'EMEND_LLM_API_KEY'],
    docs: 'https://openrouter.ai/docs/quickstart',
    suggested: ['qwen/qwen3-coder', 'deepseek/deepseek-chat', 'moonshotai/kimi-k2'],
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    keyEnv: ['EMEND_LLM_API_KEY'],
    docs: 'https://github.com/ollama/ollama/blob/main/docs/openai.md',
    suggested: ['qwen3-coder:30b', 'deepseek-coder-v2:16b'],
    keyOptional: true,
  },
  vllm: {
    id: 'vllm',
    label: 'vLLM / self-hosted (local)',
    baseUrl: 'http://localhost:8000/v1',
    keyEnv: ['EMEND_LLM_API_KEY'],
    docs: 'https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html',
    suggested: [],
    keyOptional: true,
  },
};

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  providerLabel: string;
  temperature: number;
  maxRetries: number;
}

export interface LlmConfigError {
  ok: false;
  reason: string;
}

export type LlmConfigResult = { ok: true; config: LlmConfig } | LlmConfigError;

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
  const model = overrides.model ?? process.env.EMEND_LLM_MODEL ?? '';

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
  }

  if (!baseUrl) {
    return {
      ok: false,
      reason:
        'no LLM configured. Set EMEND_LLM_PROVIDER (nebius, fireworks, together, groq, deepinfra, openrouter, ollama, vllm) or EMEND_LLM_BASE_URL.',
    };
  }
  if (!model) {
    return {
      ok: false,
      reason: 'EMEND_LLM_MODEL is not set. Run `emend models` to list what your provider serves.',
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

  return {
    ok: true,
    config: {
      baseUrl: baseUrl.replace(/\/+$/, ''),
      apiKey: apiKey || 'not-needed',
      model,
      providerLabel: label,
      temperature: Number(process.env.EMEND_LLM_TEMPERATURE ?? '0'),
      maxRetries: Number(process.env.EMEND_LLM_MAX_ATTEMPTS ?? '3'),
    },
  };
}
