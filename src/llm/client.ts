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
}

interface ChatResponseBody {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string } | string;
}

export async function chat(
  config: LlmConfig,
  messages: ChatMessage[],
  options: { jsonMode?: boolean; maxTokens?: number; timeoutMs?: number } = {},
): Promise<ChatResult> {
  const { jsonMode = true, maxTokens = 8000, timeoutMs = 180_000 } = options;

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
      return { ok: false, content: '', error: `HTTP ${res.status}: ${text.slice(0, 400)}` };
    }

    let parsed: ChatResponseBody;
    try {
      parsed = JSON.parse(text) as ChatResponseBody;
    } catch {
      return { ok: false, content: '', error: `non-JSON response: ${text.slice(0, 300)}` };
    }

    if (parsed.error) {
      const msg = typeof parsed.error === 'string' ? parsed.error : parsed.error.message;
      return { ok: false, content: '', error: msg ?? 'unknown provider error' };
    }

    const content = parsed.choices?.[0]?.message?.content ?? '';
    if (!content) return { ok: false, content: '', error: 'provider returned an empty message' };

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
    return {
      ok: false,
      content: '',
      error: e.name === 'AbortError' ? `request timed out after ${timeoutMs}ms` : e.message,
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
