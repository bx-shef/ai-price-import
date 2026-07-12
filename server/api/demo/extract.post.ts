import { extractDemo } from '~/utils/demoExtract'
import { createRateLimiter, clientKey } from '../../utils/demoRateLimit'
import { decodeText, validateDemoFile, ext, DEMO_XLSX_EXT, DEMO_AI_EXT, MAX_DEMO_BYTES } from '../../utils/demoUpload'
import { xlsxToText, XlsxTooLargeError } from '../../utils/demoXlsx'
import { runDemoAiExtract, type DemoAiDeps } from '../../utils/demoAi'
import { extractText } from '../../utils/textExtract'
import { liveExtractRunners } from '../../utils/extractRunners'
import { runAgent } from '../../agent/runAgent'
import { makeAgentSpawn } from '../../agent/spawn'
import { buildExtractionPrompt } from '../../../prompts/extract'
import { mkdir, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// POST /api/demo/extract — PUBLIC landing tryout. NO auth, NO Bitrix24, NO storage.
// Routes by format: text/csv/xlsx → deterministic extractor (instant, free); PDF /
// scan / Word → REAL AI pipeline (poppler/libreoffice/OCR → DeepSeek agent) so a
// client sees товары/контрагент/тип OR an honest error (P5-b). Rate-limited 3 files /
// 10 min per client IP — only a successfully-validated file consumes a slot. Files are
// processed in-memory / a temp file that is deleted; nothing is persisted.

const RATE_MAX = 3
const RATE_WINDOW_MS = 10 * 60 * 1000
const limiter = createRateLimiter(RATE_MAX, RATE_WINDOW_MS)

// Global cap on concurrent AI extractions (each spawns poppler/libreoffice/OCR + the
// agent). The per-IP rate limit doesn't bound aggregate load from many IPs, so cap the
// in-flight heavy jobs process-wide and shed load with 503 when saturated (DoS guard).
const AI_MAX_CONCURRENCY = Math.max(1, Number(process.env.DEMO_AI_MAX_CONCURRENCY) || 2)
let aiInFlight = 0

const DEMO_NOTICE = 'Демо-режим: файл обрабатывается публично и не сохраняется. Не загружайте конфиденциальные документы.'

// Live AI deps (backend image: poppler/libreoffice/tesseract + agent binary + DeepSeek
// env). Constructed once; runs only when a PDF/scan/office file is uploaded.
const DEMO_TMP = process.env.DEMO_TMP_DIR || '/tmp/procure-demo'
const agentSpawn = makeAgentSpawn()
const demoAiDeps: DemoAiDeps = {
  writeTemp: async (bytes, e) => {
    await mkdir(DEMO_TMP, { recursive: true })
    const p = join(DEMO_TMP, `${randomUUID()}.${e}`)
    await writeFile(p, bytes)
    return p
  },
  extractText: (path, fileName) => extractText(path, fileName, liveExtractRunners),
  runAgent: async (documentText) => {
    const out = await runAgent(
      { documentText, instructions: buildExtractionPrompt() },
      { spawn: agentSpawn, sleep: ms => new Promise(r => setTimeout(r, ms)), random: () => Math.random() }
    )
    return { ok: out.ok, document: out.document, error: out.error }
  },
  cleanup: p => unlink(p).then(() => {}, () => {})
}

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
    return { error: 'Файл слишком большой для демо (до 5 МБ).' }
  }

  // A malformed/truncated multipart body (bad boundary, corrupt payload under the cap)
  // makes h3's parser throw — catch it so a bad request yields a clean {error}, not a 500.
  let form
  try {
    form = await readMultipartFormData(event)
  } catch {
    setResponseStatus(event, 400)
    return { error: 'Не удалось прочитать загруженный файл.' }
  }
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

  const e = ext(file.filename)

  // AI path: PDF / scan / Word → extract text (poppler/libreoffice/OCR) → DeepSeek
  // agent → structured result or an honest error (never a 500 for a bad document).
  if (DEMO_AI_EXT.includes(e)) {
    // Shed load when too many heavy extractions are already running (global DoS guard).
    if (aiInFlight >= AI_MAX_CONCURRENCY) {
      setResponseStatus(event, 503)
      event.node.res.setHeader('Retry-After', '30')
      return { error: 'Демо сейчас перегружено разбором. Попробуйте через минуту.' }
    }
    aiInFlight++
    let out
    try {
      out = await runDemoAiExtract(file.data, file.filename, demoAiDeps)
    } finally {
      aiInFlight--
    }
    if (out.error || !out.result) {
      setResponseStatus(event, 422)
      return { error: out.error || 'Не удалось разобрать документ.' }
    }
    return { result: out.result, notice: DEMO_NOTICE, remaining: decision.remaining }
  }

  // Deterministic path: spreadsheet → tab-separated text (row/col-capped); text file →
  // decode. Then the deterministic extractor. A zip/XML bomb over budget is a 413.
  let text: string
  if (DEMO_XLSX_EXT.includes(e)) {
    try {
      text = await xlsxToText(file.data)
    } catch (err) {
      if (err instanceof XlsxTooLargeError) {
        setResponseStatus(event, 413)
        return { error: 'Excel-файл слишком большой для демо. Попробуйте меньший файл или текстовую выгрузку.' }
      }
      setResponseStatus(event, 422)
      return { error: 'Не удалось прочитать Excel-файл. Попробуйте .xlsx или текстовую выгрузку.' }
    }
  } else {
    text = decodeText(file.data)
  }

  return { result: extractDemo(text), notice: DEMO_NOTICE, remaining: decision.remaining }
})
