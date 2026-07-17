// Live verification of the REAL extraction agent path (dev-only, not part of SSG). Unlike
// `pnpm live:crm --ai` (which does a direct fetch shortcut), this exercises the ACTUAL production
// path: makeAgentSpawn() → spawns the `claude` CLI subprocess (sanitized env, timeout, zero tools)
// pointed at DeepSeek via the Anthropic-compat endpoint → runAgent() with transient-retry →
// validated ExtractedDocument. Proves the agent-run queue stage works end-to-end.
//
//   pnpm verify:agent
//
// Requires the `claude` CLI on PATH (AGENT_BIN) and .env with ANTHROPIC_BASE_URL /
// ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL (DeepSeek). No Bitrix24 access (pure text→JSON).
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

const DOC_TEXT = [
  'ТОВАРНАЯ НАКЛАДНАЯ № ТН-2026-777 от 14.07.2026',
  'Поставщик: ООО «Тест-Поставщик»  ИНН: 7712345678',
  'Наименование | Артикул | Кол-во | Ед. | Цена | Сумма',
  'Кабель ВВГ 3х2.5 | KAB-325 | 500 | м | 1.20 | 600.00',
  'Автомат С16 | AVT-C16 | 30 | шт | 4.50 | 135.00',
  'Итого: 735.00', 'НДС 20%: 147.00', 'Всего к оплате: 882.00', 'Валюта: BYN'
].join('\n')

console.log('── verify:agent · РЕАЛЬНЫЙ путь агента (claude CLI → DeepSeek) ──')
console.log(`bin=${process.env.AGENT_BIN ?? 'claude'} base=${process.env.ANTHROPIC_BASE_URL} model=${process.env.ANTHROPIC_MODEL ?? 'deepseek-v4-flash'}`)

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
  check('валюта распознана', doc.currency === 'BYN', String(doc.currency))
  check('первая позиция имеет name+quantity+price', !!doc.items?.[0]?.name && doc.items[0].quantity != null && doc.items[0].price != null,
    JSON.stringify(doc.items?.[0] ?? null))
}
console.log(fail === 0 ? `\n✅ РЕАЛЬНЫЙ путь агента отрабатывает (${ms}ms)` : `\n❌ провалено: ${fail}`)
process.exit(fail === 0 ? 0 : 1)
