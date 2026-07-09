import { extractDemo } from '~/utils/demoExtract'
import { createRateLimiter, clientKey } from '../../utils/demoRateLimit'
import { decodeText, validateDemoFile, MAX_DEMO_BYTES } from '../../utils/demoUpload'

// POST /api/demo/extract — PUBLIC landing tryout. NO auth, NO Bitrix24, NO storage.
// Accepts a small text document (txt/csv), runs the deterministic extractor, returns
// the parsed result. Rate-limited 3 files / 10 min per client IP — but only a
// successfully-validated file consumes a slot (bad drops don't burn the quota).
// Files are parsed in-memory and dropped. Users are warned about publicity in the UI.

const RATE_MAX = 3
const RATE_WINDOW_MS = 10 * 60 * 1000

// Process-wide limiter (best-effort; the demo does not need cross-instance accuracy).
const limiter = createRateLimiter(RATE_MAX, RATE_WINDOW_MS)

export default defineEventHandler(async (event) => {
  // Require a Content-Length: browsers set it for FormData uploads. Refusing chunked
  // bodies with no declared length stops an unbounded in-memory buffer (DoS).
  const declared = Number(getHeader(event, 'content-length') || 0)
  if (!declared) {
    setResponseStatus(event, 411)
    return { error: 'Не указан размер запроса.' }
  }
  if (declared > MAX_DEMO_BYTES + 100_000) {
    setResponseStatus(event, 413)
    return { error: 'Файл слишком большой для демо (до 1 МБ текста).' }
  }

  const form = await readMultipartFormData(event)
  const file = form?.find(p => p.name === 'file' && p.filename)
  if (!file || !file.filename || !file.data?.length) {
    setResponseStatus(event, 400)
    return { error: 'Файл не передан.' }
  }

  // Validate BEFORE consuming a rate-limit slot — a rejected file must not burn quota.
  const v = validateDemoFile(file.filename, file.data.length)
  if (!v.ok) {
    setResponseStatus(event, v.status ?? 400)
    return { error: v.error }
  }

  const now = Date.now()
  const key = clientKey(getHeader(event, 'x-forwarded-for'), event.node.req.socket?.remoteAddress)
  limiter.sweep(now)
  const decision = limiter.check(key, now)
  if (!decision.allowed) {
    setResponseStatus(event, 429)
    event.node.res.setHeader('Retry-After', String(Math.ceil(decision.retryAfterMs / 1000)))
    return {
      error: 'Превышен лимит демо: 3 файла за 10 минут. Попробуйте позже.',
      retryAfterSec: Math.ceil(decision.retryAfterMs / 1000)
    }
  }

  const result = extractDemo(decodeText(file.data))
  return {
    result,
    notice: 'Демо-режим: файл обрабатывается публично и не сохраняется. Не загружайте конфиденциальные документы.',
    remaining: decision.remaining
  }
})
