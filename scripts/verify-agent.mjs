// Live verification of the REAL extraction agent path (dev-only, not part of SSG). Unlike
// `pnpm live:crm --ai` (which does a direct fetch shortcut), this exercises the ACTUAL production
// path: makeAgentSpawn() → spawns the `claude` CLI subprocess (sanitized env, timeout, zero tools)
// pointed at DeepSeek via the Anthropic-compat endpoint → runAgent() with transient-retry →
// validated ExtractedDocument. Proves the agent-run queue stage works end-to-end.
//
//   pnpm verify:agent                              # built-in RU накладная (BYN)
//   pnpm verify:agent --doc public/demo/invoice-be.txt  # any document file (multilingual)
//
// `--doc` runs the agent on a real sample (rus/bel/kaz) to prove multilingual extraction +
// country-aware tax-id recognition (ИНН/УНП/БИН/ИИН). Requires the `claude` CLI on PATH
// (AGENT_BIN) and .env with ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL
// (DeepSeek). No Bitrix24 access (pure text→JSON).
import { readFileSync } from 'node:fs'
import { makeAgentSpawn } from '../server/agent/spawn.ts'
import { runAgent } from '../server/agent/runAgent.ts'
import { buildExtractionPrompt } from '../prompts/extract.ts'

// Load the ANTHROPIC_* vars from the git-ignored .env into process.env so agentSpawnEnv (which
// allowlists exactly these) forwards them to the claude subprocess. Anchored to line start.
const envText = readFileSync('.env', 'utf8')
for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL']) {
  const m = envText.match(new RegExp(`^\\s*${key}=(.+)$`, 'm'))
  if (m) process.env[key] = m[1].trim().replace(/^["']|["']$/g, '')
}
if (!process.env.ANTHROPIC_AUTH_TOKEN) {
  console.error('✗ ANTHROPIC_AUTH_TOKEN not set in .env')
  process.exit(1)
}

// Optional --doc <path> runs a real sample file (multilingual); default = built-in RU накладная.
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

console.log('── verify:agent · РЕАЛЬНЫЙ путь агента (claude CLI → DeepSeek) ──')
console.log(`bin=${process.env.AGENT_BIN ?? 'claude'} base=${process.env.ANTHROPIC_BASE_URL} model=${process.env.ANTHROPIC_MODEL ?? 'deepseek-v4-flash'}`)
console.log(`doc=${docArg || '(built-in RU накладная)'}`)

const spawn = makeAgentSpawn() // sanitized env + timeout, bin from AGENT_BIN
const t0 = Date.now()
const outcome = await runAgent(
  { documentText: DOC_TEXT, instructions: buildExtractionPrompt() },
  { spawn, sleep: ms => new Promise(res => setTimeout(res, ms)), random: () => Math.random() }
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

check('runAgent ok (subprocess завершился, JSON распарсен)', outcome.ok, `attempts=${outcome.attempts} ${ms}ms${outcome.error ? ` err=${outcome.error}` : ''}`)
const doc = outcome.document
check('извлечён документ с позициями', !!doc && Array.isArray(doc.items) && doc.items.length > 0, doc ? `items=${doc.items?.length}` : 'нет документа')
if (doc) {
  check('тип документа распознан', typeof doc.documentType === 'string' && doc.documentType.length > 0, doc.documentType)
  check('первая позиция имеет name+quantity+price', !!doc.items?.[0]?.name && doc.items[0].quantity != null && doc.items[0].price != null,
    JSON.stringify(doc.items?.[0] ?? null))
  // Multilingual signal: the tax-id KIND must be recognized by the document's language/country
  // (ИНН/УНП/БИН/ИИН). Print supplier so a bel/kaz run visibly proves country-aware recognition.
  const sup = doc.supplier ?? {}
  console.log(`  supplier: name="${sup.name ?? ''}" taxId=${sup.taxId ?? '—'} kind=${sup.taxIdKind ?? '—'} · currency=${doc.currency}`)
  const hasTaxId = typeof sup.taxId === 'string' && /^\d+$/.test(sup.taxId)
  // For the known `public/demo/*-{ru,be,kk}.*` samples, ENFORCE the country-correct kind (not just
  // "any of the four") — otherwise a misclassification (bel УНП → INN) would pass silently and the
  // "распознан по стране" claim would be a false-positive. `ru`→INN, `be`→UNP, `kk`→BIN|IIN (юрлицо
  // БСН vs ИП ЖСН — the sample prints БСН→BIN). Unknown/ad-hoc docs fall back to "any valid kind".
  const langHint = (docArg.match(/-(ru|be|kk)\.[a-z]+$/) ?? [])[1]
  const expected = { ru: ['INN'], be: ['UNP'], kk: ['BIN', 'IIN'] }[langHint] ?? ['INN', 'UNP', 'BIN', 'IIN']
  check(`налоговый ID по стране/языку${langHint ? ` (${langHint} → ${expected.join('|')})` : ''}`,
    hasTaxId && expected.includes(sup.taxIdKind),
    `${sup.taxId ?? '—'}/${sup.taxIdKind ?? '—'}`)
  // The built-in RU sample states BYN → assert it. A --doc sample keeps whatever the document
  // states; currency may be legitimately ABSENT (e.g. a счёт that only prints a BY… account, no
  // «BYN» word) — the extractor must NOT invent one, so undefined is acceptable there (printed above).
  if (!docArg) check('валюта распознана', doc.currency === 'BYN', String(doc.currency))
}
console.log(fail === 0 ? `\n✅ РЕАЛЬНЫЙ путь агента отрабатывает (${ms}ms)` : `\n❌ провалено: ${fail}`)
process.exit(fail === 0 ? 0 : 1)
