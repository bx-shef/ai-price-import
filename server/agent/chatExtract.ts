import { extractJson } from './extractJson'
import { classifyAgentError, nextBackoffMs, shouldRetry } from './retry'
import { MAX_ITEMS, validateExtractedDocument } from '~/utils/extractedDocument'
import type { RunAgentOutcome } from './runAgent'

// OpenAI-compatible chat extractor (variant 2 — replaces the claude-code subprocess).
// Same contract as runAgent: document text + instructions → ExtractedDocument, PURE extractor
// (no tools, no Bitrix24 access — an injected document can only emit JSON, never exfiltrate).
// Pure control-flow with an injected `chat` transport → unit-tested with a fake. The live
// transport (openaiChat.makeChatFn) speaks the OpenAI /v1/chat/completions contract, which
// DeepSeek and the Bitrix Vibecode AI Router (BitrixGPT) both implement.

const MAX_ERR = 300

export interface ChatMessage { role: 'system' | 'user', content: string }

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  temperature: number
  /** Force a JSON object reply (the extract prompt already mandates a single JSON object). */
  response_format: { type: 'json_object' }
}

/**
 * The injected transport: send one chat-completion request, resolve with the assistant's
 * text content. MUST throw on a provider/transport error (the message should carry the HTTP
 * status so classifyAgentError can tell a transient 429/5xx from a terminal fault).
 */
export type ChatFn = (req: ChatRequest) => Promise<string>

export interface ChatExtractDeps {
  chat: ChatFn
  /** Backoff sleep between transient retries (injected → tests don't wait). */
  sleep: (ms: number) => Promise<void>
  /** Jitter source in [0,1) (injected → deterministic tests). */
  random: () => number
}

export interface ChatExtractInput {
  documentText: string
  /** Extraction system prompt (same one used by the claude path). */
  instructions: string
  model: string
  maxAttempts?: number
}

/** Build the chat-completions request: instructions as system, document as user, JSON forced. */
export function buildChatRequest(model: string, instructions: string, documentText: string): ChatRequest {
  return {
    model,
    messages: [
      { role: 'system', content: instructions },
      { role: 'user', content: documentText }
    ],
    // Deterministic extraction — we want the printed values verbatim, not creative variation.
    temperature: 0,
    response_format: { type: 'json_object' }
  }
}

/** Bound an error string so retained job status can't carry large echoed content. */
function boundErr(s: string): string {
  const t = (s || '').trim().replace(/\s+/g, ' ')
  return t.length > MAX_ERR ? `${t.slice(0, MAX_ERR)}…` : t
}

/** Run the chat extractor with transient-retry. Never throws — returns an outcome. */
export async function runChatExtract(input: ChatExtractInput, deps: ChatExtractDeps): Promise<RunAgentOutcome> {
  const req = buildChatRequest(input.model, input.instructions, input.documentText)
  const maxAttempts = input.maxAttempts ?? 3
  let attempt = 0
  let lastError = 'agent failed'
  while (attempt < maxAttempts) {
    attempt++
    let content: string
    try {
      content = await deps.chat(req)
    } catch (e) {
      lastError = boundErr(e instanceof Error ? e.message : String(e)) || 'agent error'
      if (shouldRetry(classifyAgentError(lastError), attempt, maxAttempts)) {
        await deps.sleep(nextBackoffMs(attempt, deps.random()))
        continue
      }
      return { ok: false, document: null, attempts: attempt, error: lastError }
    }

    // With response_format:json_object the content should be pure JSON, but extractJson is
    // robust to a stray wrapper (defence in depth — same parser as the claude path).
    const raw = extractJson(content)
    const rawItems = (raw as { items?: unknown })?.items
    if (Array.isArray(rawItems) && rawItems.length > MAX_ITEMS) {
      return { ok: false, document: null, attempts: attempt, error: `слишком много позиций (>${MAX_ITEMS}) — разбейте документ на части` }
    }
    const doc = validateExtractedDocument(raw)
    if (doc) return { ok: true, document: doc, attempts: attempt }
    // Clean reply but no usable tabular part → terminal (same input won't re-extract).
    return { ok: false, document: null, attempts: attempt, error: 'агент не извлёк табличную часть' }
  }
  return { ok: false, document: null, attempts: attempt, error: lastError }
}
