/**
 * Minimal OpenAI-compatible chat client.
 *
 * Zero dependencies — this is a `fetch` call and a JSON parse. Pulling in an SDK
 * would buy nothing here: every provider Emend targets (Nebius, Fireworks,
 * Together, Groq, DeepInfra, OpenRouter, vLLM, Ollama) speaks the same wire
 * protocol, and Emend only needs non-streaming chat completions.
 */

import type { LlmConfig } from './providers.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatResult {
  ok: boolean;
  content: string;
  error?: string;
  usage?: { promptTokens: number; completionTokens: number };
  /**
   * Whether asking again could plausibly give a different answer. Only
   * meaningful when `ok` is false.
   *
   * Carried on the result rather than beside it because it is a property of the
   * failure — a rejected API key is permanent, a 503 is not — and only the code
   * holding the status and `finish_reason` can tell which. Callers other than
   * the retry loop can ignore it.
   */
  transient?: boolean;
}

interface ChatResponseBody {
  // finish_reason distinguishes a truncated answer from a genuinely blank one,
  // which is the difference between "raise max_tokens" and "the provider hiccuped".
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string } | string;
}

/**
 * Transport-level attempts, distinct from `config.maxRetries`.
 *
 * `maxRetries` counts attempts at *improving a migration* — each one costs a
 * full verification and shows the model new compiler output. A network blip is
 * not that, and spending one of those on it is a bad trade: on the run that
 * prompted this, a single empty response consumed the only attempt the loop
 * ever made and the whole migration was abandoned with zero edits.
 */
const TRANSPORT_ATTEMPTS = 3;

export async function chat(
  config: LlmConfig,
  messages: ChatMessage[],
  options: { jsonMode?: boolean; maxTokens?: number; timeoutMs?: number } = {},
): Promise<ChatResult> {
  let last: ChatResult = { ok: false, content: '', error: 'no attempt made' };
  for (let attempt = 1; attempt <= TRANSPORT_ATTEMPTS; attempt++) {
    last = await chatOnce(config, messages, options);
    if (last.ok) return last;
    if (attempt === TRANSPORT_ATTEMPTS || !last.transient) break;
    // Linear rather than exponential: the ceiling is three attempts, so the
    // difference is a second of wall clock against a migration that takes minutes.
    await new Promise((r) => setTimeout(r, attempt * 1000));
  }
  return last;
}

/**
 * One request, which also decides whether its own failure is worth repeating.
 *
 * Classification lives here because this is where the status code and
 * `finish_reason` are. The caller only ever saw a string, and a string cannot
 * distinguish "the socket died" from "your API key is wrong".
 */
async function chatOnce(
  config: LlmConfig,
  messages: ChatMessage[],
  options: { jsonMode?: boolean; maxTokens?: number; timeoutMs?: number } = {},
): Promise<ChatResult> {
  const { jsonMode = true, maxTokens = config.maxTokens, timeoutMs = 180_000 } = options;

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: config.temperature,
    max_tokens: maxTokens,
  };
  // Widely supported across OpenAI-compatible hosts. Harmless where ignored,
  // because the prompt also demands raw JSON and the parser tolerates fences.
  if (jsonMode) body['response_format'] = { type: 'json_object' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      // 4xx means the request itself is wrong — a rejected key or an unknown
      // model will be exactly as wrong the second time. 429 is the exception.
      return {
        ok: false,
        content: '',
        error: `HTTP ${res.status}: ${text.slice(0, 400)}`,
        transient: res.status === 429 || res.status >= 500,
      };
    }

    let parsed: ChatResponseBody;
    try {
      parsed = JSON.parse(text) as ChatResponseBody;
    } catch {
      // A 200 carrying a non-JSON body is usually an intermediary, not the model.
      return {
        ok: false,
        content: '',
        error: `non-JSON response: ${text.slice(0, 300)}`,
        transient: true,
      };
    }

    if (parsed.error) {
      const msg = typeof parsed.error === 'string' ? parsed.error : parsed.error.message;
      return {
        ok: false,
        content: '',
        error: msg ?? 'unknown provider error',
        transient: true,
      };
    }

    const content = parsed.choices?.[0]?.message?.content ?? '';
    if (!content) {
      const reason = parsed.choices?.[0]?.finish_reason;
      // `length` means the model ran out of output budget before saying anything
      // — deterministic, so asking again just burns the same tokens to the same
      // end. Say what to change instead of retrying three times in silence.
      const truncated = reason === 'length';
      return {
        ok: false,
        content: '',
        error: truncated
          ? `ran out of output tokens before producing a reply (max_tokens=${maxTokens}). ` +
            'Raise EMEND_LLM_MAX_TOKENS, or use a model that reasons less.'
          : `provider returned an empty message${reason ? ` (finish_reason: ${reason})` : ''}`,
        transient: !truncated,
      };
    }

    return {
      ok: true,
      content,
      usage: {
        promptTokens: parsed.usage?.prompt_tokens ?? 0,
        completionTokens: parsed.usage?.completion_tokens ?? 0,
      },
    };
  } catch (err) {
    const e = err as Error;
    // A socket failure is worth another try; a timeout has already waited.
    const timedOut = e.name === 'AbortError';
    return {
      ok: false,
      content: '',
      error: timedOut ? `request timed out after ${timeoutMs}ms` : e.message,
      transient: !timedOut,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** List model IDs the configured endpoint serves. */
export async function listModels(config: LlmConfig): Promise<{ ok: boolean; models: string[]; error?: string }> {
  try {
    const res = await fetch(`${config.baseUrl}/models`, {
      headers: { authorization: `Bearer ${config.apiKey}` },
    });
    if (!res.ok) {
      return { ok: false, models: [], error: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
    }
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const models = (body.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
    return { ok: true, models: models.sort() };
  } catch (err) {
    return { ok: false, models: [], error: (err as Error).message };
  }
}

/**
 * Extract a JSON object from a model response.
 *
 * Open-weight models frequently wrap JSON in markdown fences or prose despite
 * being told not to. Failing the whole migration over a stray ``` would be a
 * pointless loss, so recover the object rather than rejecting it.
 */
export function extractJson(raw: string): unknown | null {
  const trimmed = raw.trim();

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], trimmed].filter((s): s is string => Boolean(s));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* try the next candidate */
    }
  }

  // Last resort: the outermost balanced {...} span.
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}
