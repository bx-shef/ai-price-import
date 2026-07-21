import OpenAI from 'openai'
import type { ChatFn, ChatRequest } from './chatExtract'
import type { LlmConfig } from './llmConfig'

// Live transport for the chat extractor: the OpenAI SDK pointed at an OpenAI-compatible
// endpoint (DeepSeek or the Bitrix Vibecode AI Router / BitrixGPT). Thin glue — the retry,
// parsing and validation live in the (unit-tested) runChatExtract; this file is the I/O edge,
// like server/agent/spawn.ts for the claude path, so it is not itself unit-tested.
//
// In-SDK retry is DISABLED (maxRetries:0): runChatExtract owns the transient-retry policy
// (classifyAgentError + backoff), matching the claude path — one place decides retries.

export const CHAT_TIMEOUT_MS = 120_000

/**
 * Normalise an SDK/transport error to a message classifyAgentError can read: a transient
 * 429/5xx vs a terminal fault. No secrets echoed (status/code/message only — the OpenAI SDK
 * never puts the API key in these).
 *
 * HTTP errors (RateLimitError/InternalServerError) carry a numeric `.status` → prepend it so
 * `\b429\b`/`\b5\d\d\b` match. A NETWORK fault (APIConnectionError) has `status:undefined` and a
 * generic "Connection error." message — the real ECONNRESET/ETIMEDOUT/ENOTFOUND/EAI_AGAIN code
 * sits on `.code`/`.cause`, which retry.ts's transient list enumerates. Fold it in, else a
 * connection blip the claude path would retry becomes a hard failure here.
 */
export function normaliseError(e: unknown): Error {
  const err = e as { status?: unknown, code?: unknown, cause?: { code?: unknown, message?: unknown } }
  const msg = e instanceof Error ? e.message : String(e)
  if (typeof err?.status === 'number') return new Error(`${err.status} ${msg}`)
  // No HTTP status ⇒ likely a network fault: surface the transient code from code/cause.
  const netCode = [err?.code, err?.cause?.code, err?.cause?.message].find(v => typeof v === 'string') as string | undefined
  return new Error(netCode ? `${netCode} ${msg}` : msg)
}

/** Build a ChatFn bound to a provider config. Fails closed (clear error) if the key is unset. */
export function makeChatFn(config: LlmConfig, timeoutMs: number = CHAT_TIMEOUT_MS): ChatFn {
  if (!config.apiKey) {
    // Terminal, explicit: an empty key would otherwise surface as an opaque 401 per request.
    return async () => {
      throw new Error(`LLM provider '${config.label}' not configured (missing API key)`)
    }
  }
  const client = new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey, timeout: timeoutMs, maxRetries: 0 })
  return async (req: ChatRequest): Promise<string> => {
    try {
      const res = await client.chat.completions.create({
        model: req.model,
        messages: req.messages,
        temperature: req.temperature,
        response_format: req.response_format,
        stream: false
      })
      return res.choices?.[0]?.message?.content ?? ''
    } catch (e) {
      throw normaliseError(e)
    }
  }
}
