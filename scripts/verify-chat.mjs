// Live verification of the OpenAI-compatible chat extractor (variant 2 — replaces claude-code).
// Exercises the REAL production path: resolveLlmConfig(env) → makeChatFn (OpenAI SDK against the
// provider's /v1/chat/completions) → runChatExtract() with transient-retry → validated
// ExtractedDocument. No Bitrix24 access (pure text→JSON). Dev-only, not part of SSG.
//
//   pnpm verify:chat                                  # provider from .env (LLM_PROVIDER), built-in RU накладная
//   pnpm verify:chat --provider deepseek              # force DeepSeek (step 2)
//   pnpm verify:chat --provider bitrixgpt             # force BitrixGPT / AI Router (step 3)
//   pnpm verify:chat --doc public/demo/invoice-be.txt # any document file (multilingual)
//
// Requires .env with the chosen provider's key:
//   deepseek  → DEEPSEEK_API_KEY (+ opt. DEEPSEEK_BASE_URL / DEEPSEEK_MODEL)
//   bitrixgpt → VIBE_API_KEY or BITRIXGPT_API_KEY (+ opt. BITRIXGPT_MODEL)
//   custom    → LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
import { readFileSync } from 'node:fs'
import { resolveLlmConfig } from '../server/agent/llmConfig.ts'
import { makeChatFn } from '../server/agent/openaiChat.ts'
import { runChatExtract } from '../server/agent/chatExtract.ts'
import { buildExtractionPrompt } from '../prompts/extract.ts'

// Load the provider vars from the git-ignored .env into process.env (anchored to line start).
const ENV_KEYS = [
  'LLM_PROVIDER',
  'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL',
  'BITRIXGPT_API_KEY', 'VIBE_API_KEY', 'BITRIXGPT_BASE_URL', 'BITRIXGPT_MODEL',
  'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_LABEL'
]
try {
  const envText = readFileSync('.env', 'utf8')
  for (const key of ENV_KEYS) {
    const m = envText.match(new RegExp(`^\\s*${key}=(.+)$`, 'm'))
    if (m) process.env[key] = m[1].trim().replace(/^["']|["']$/g, '')
  }
} catch { /* no .env — rely on the ambient environment */ }

// --provider <p> overrides LLM_PROVIDER for this run (so one .env can test both, step 2 then 3).
const argProvider = (() => {
  const i = process.argv.indexOf('--provider')
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : ''
})()
if (argProvider) process.env.LLM_PROVIDER = argProvider

const docArg = (() => {
  const i = process.argv.indexOf('--doc')
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : ''
})()
const BUILTIN_TEXT = [
  'ТОВАРНАЯ НАКЛАДНАЯ № ТН-2026-777 от 14.07.2026',
  'Поставщик: ООО «Тест-Поставщик»  ИНН: 7712345678',
  'Наименование | Артикул | Кол-во | Ед. | Цена | Сумма',
  'Кабель ВВГ 3х2.5 | KAB-325 | 500 | м | 1.20 | 600.00',
  'Автомат С16 | AVT-C16 | 30 | шт | 4.50 | 135.00',
  'Итого: 735.00', 'НДС 20%: 147.00', 'Всего к оплате: 882.00', 'Валюта: BYN'
].join('\n')
const DOC_TEXT = docArg ? readFileSync(docArg, 'utf8') : BUILTIN_TEXT

const config = resolveLlmConfig(process.env)
console.log('── verify:chat · РЕАЛЬНЫЙ путь экстрактора (OpenAI-совместимый транспорт) ──')
console.log(`provider=${config.label} base=${config.baseURL} model=${config.model}`)
console.log(`doc=${docArg || '(built-in RU накладная)'}`)
if (!config.apiKey) {
  console.error(`✗ нет ключа для провайдера '${config.label}' — задай ключ в .env (см. шапку скрипта)`)
  process.exit(1)
}

const chat = makeChatFn(config)
const t0 = Date.now()
const outcome = await runChatExtract(
  { documentText: DOC_TEXT, instructions: buildExtractionPrompt(), model: config.model },
  { chat, sleep: ms => new Promise(res => setTimeout(res, ms)), random: () => Math.random() }
)
const ms = Date.now() - t0

let fail = 0
const check = (name, cond, detail = '') => {
  if (cond) {
    console.log(`✓ ${name}${detail ? `  ${detail}` : ''}`)
  } else {
    fail++
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

check('runChatExtract ok (ответ получен, JSON распарсен)', outcome.ok, `attempts=${outcome.attempts} ${ms}ms${outcome.error ? ` err=${outcome.error}` : ''}`)
const doc = outcome.document
check('извлечён документ с позициями', !!doc && Array.isArray(doc.items) && doc.items.length > 0, doc ? `items=${doc.items?.length}` : 'нет документа')
if (doc) {
  check('тип документа распознан', typeof doc.documentType === 'string' && doc.documentType.length > 0, doc.documentType)
  check('первая позиция имеет name+quantity+price', !!doc.items?.[0]?.name && doc.items[0].quantity != null && doc.items[0].price != null,
    JSON.stringify(doc.items?.[0] ?? null))
  const sup = doc.supplier ?? {}
  console.log(`  supplier: name="${sup.name ?? ''}" taxId=${sup.taxId ?? '—'} kind=${sup.taxIdKind ?? '—'} · currency=${doc.currency}`)
  const hasTaxId = typeof sup.taxId === 'string' && /^\d+$/.test(sup.taxId)
  const langHint = (docArg.match(/-(ru|be|kk)\.[a-z]+$/) ?? [])[1]
  const expected = { ru: ['INN'], be: ['UNP'], kk: ['BIN', 'IIN'] }[langHint] ?? ['INN', 'UNP', 'BIN', 'IIN']
  check(`налоговый ID по стране/языку${langHint ? ` (${langHint} → ${expected.join('|')})` : ''}`,
    hasTaxId && expected.includes(sup.taxIdKind), `${sup.taxId ?? '—'}/${sup.taxIdKind ?? '—'}`)
  if (!docArg) check('валюта распознана', doc.currency === 'BYN', String(doc.currency))
}
console.log(fail === 0 ? `\n✅ РЕАЛЬНЫЙ путь экстрактора (${config.label}) отрабатывает (${ms}ms)` : `\n❌ провалено: ${fail}`)
process.exit(fail === 0 ? 0 : 1)
