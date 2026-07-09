import { extractDemo } from '~/utils/demoExtract'
import { createRateLimiter, clientKey } from '../../utils/demoRateLimit'

// POST /api/demo/extract — PUBLIC landing tryout. NO auth, NO Bitrix24, NO storage.
// Accepts a small text document (txt/csv), runs the deterministic extractor, returns
// the parsed result. Rate-limited 3 files / 10 min per client IP. Files are NOT
// persisted — parsed in-memory and dropped. Users are warned about publicity in the UI.

const MAX_DEMO_BYTES = 1024 * 1024 // 1 MB — plenty for a text document
const DEMO_ALLOWED_EXT = ['txt', 'csv', 'tsv', 'text']
const RATE_MAX = 3
const RATE_WINDOW_MS = 10 * 60 * 1000

// Process-wide limiter (best-effort; the demo does not need cross-instance accuracy).
const limiter = createRateLimiter(RATE_MAX, RATE_WINDOW_MS)

function ext(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

/** Decode bytes as UTF-8, falling back to Windows-1251 for legacy CIS documents. */
function decodeText(bytes: Uint8Array): string {
  try {
    const utf8 = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return utf8
  } catch {
    try {
      return new TextDecoder('windows-1251').decode(bytes)
    } catch {
      return new TextDecoder('utf-8').decode(bytes) // last resort, lossy
    }
  }
}

export default defineEventHandler(async (event) => {
  const now = Date.now()
  const key = clientKey(getHeader(event, 'x-forwarded-for'), event.node.req.socket?.remoteAddress)
  const decision = limiter.check(key, now)
  if (!decision.allowed) {
    setResponseStatus(event, 429)
    event.node.res.setHeader('Retry-After', String(Math.ceil(decision.retryAfterMs / 1000)))
    return {
      error: 'Превышен лимит демо: 3 файла за 10 минут. Попробуйте позже.',
      retryAfterSec: Math.ceil(decision.retryAfterMs / 1000)
    }
  }
  limiter.sweep(now)

  const declared = Number(getHeader(event, 'content-length') || 0)
  if (declared && declared > MAX_DEMO_BYTES + 100_000) {
    setResponseStatus(event, 413)
    return { error: 'Файл слишком большой для демо (до 1 МБ текста).' }
  }

  const form = await readMultipartFormData(event)
  const file = form?.find(p => p.name === 'file' && p.filename)
  if (!file || !file.filename || !file.data?.length) {
    setResponseStatus(event, 400)
    return { error: 'Файл не передан.' }
  }
  if (file.data.length > MAX_DEMO_BYTES) {
    setResponseStatus(event, 413)
    return { error: 'Файл слишком большой для демо (до 1 МБ текста).' }
  }
  if (!DEMO_ALLOWED_EXT.includes(ext(file.filename))) {
    setResponseStatus(event, 415)
    return {
      error: 'Демо принимает текстовые файлы (.txt/.csv). Для PDF/сканов/office — полная версия внутри Bitrix24.'
    }
  }

  const text = decodeText(file.data)
  const result = extractDemo(text)
  return {
    result,
    notice: 'Демо-режим: файл обрабатывается публично и не сохраняется. Не загружайте конфиденциальные документы.',
    remaining: decision.remaining
  }
})
