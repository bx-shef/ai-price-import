// Live end-to-end check of the document→CRM happy path against a real test portal.
// Dev-only (like seed:b24). Runs the REAL crm-sync (server/queue/crmSyncCore) with a
// webhook-backed RestCall, routing by document type: накладная→deal / счёт→smart-invoice /
// КП→quote. Optionally runs the DeepSeek extraction first.
//
//   pnpm live:crm             # crafted накладная → deal (entityTypeId 2) → verify → delete
//   pnpm live:crm --type счёт  # crafted счёт → smart-invoice (entityTypeId 31, xmlId marker)
//   pnpm live:crm --ai        # document TEXT → DeepSeek → runCrmSync → verify → delete
//   pnpm live:crm --keep      # do not delete the created entity
//
// `--type` exercises the routing table below: накладная→deal (originId marker) and
// счёт→smart-invoice (xmlId marker) are DISTINCT idempotency code paths, so both are worth a
// live run. Reads git-ignored env: .env.b24test (B24_TEST_WEBHOOK) and, with --ai, .env
// (ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN). Creates then deletes a [TEST] entity.
import { readFileSync } from 'node:fs'
import { buildExtractionPrompt } from '../prompts/extract.ts'
import { runCrmSync } from '../server/queue/crmSyncCore.ts'
import { resolveAgentEngine, resolveLlmConfig } from '../server/agent/llmConfig.ts'
import { makeChatFn } from '../server/agent/openaiChat.ts'
import { runChatExtract } from '../server/agent/chatExtract.ts'
import { findCompanyByTaxId } from '../server/utils/companyLookup.ts'
import { findProduct } from '../server/utils/productLookup.ts'
import { fetchVatRates } from '../server/utils/portalVat.ts'
import { fetchCurrencies } from '../server/utils/portalCurrency.ts'
import { createTargetItem, setProductRows } from '../server/utils/crmWrite.ts'
import { findExistingItemId } from '../server/utils/originLookup.ts'

const argv = process.argv.slice(2)
const args = new Set(argv)
const useAi = args.has('--ai')
const keep = args.has('--keep')
// Document type to route on: `--type счёт` or `--type=счёт` (default накладная). Only the
// types present in `mapping.routingRules` below route to a distinct target; anything else
// falls through to `defaultTarget`.
const typeArg = (() => {
  const eq = argv.find(a => a.startsWith('--type='))
  if (eq) return eq.slice('--type='.length)
  const i = argv.indexOf('--type')
  return i >= 0 && argv[i + 1] ? argv[i + 1] : ''
})()
const DOC_TYPE = typeArg || 'накладная'

const readEnv = (file, key) => {
  // Anchor to line start (^…$ with the m flag) so a commented `#KEY=…` or a longer
  // variable ending with KEY can't be captured; strip surrounding quotes.
  const m = readFileSync(file, 'utf8').match(new RegExp(`^\\s*${key}=(.+)$`, 'm'))
  if (!m) throw new Error(`${key} not found in ${file}`)
  return m[1].trim().replace(/^["']|["']$/g, '')
}
const WEBHOOK = readEnv('.env.b24test', 'B24_TEST_WEBHOOK')

const call = async (method, params = {}) => {
  const r = await fetch(`${WEBHOOK}${method}.json`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) })
  const j = await r.json()
  if (j.error) throw new Error(`${method}: ${j.error} ${j.error_description || ''}`)
  return j.result
}

// fetchVatRates takes an SdkListCall (full-list fetch). This dev script talks to the portal
// over a webhook, not the SDK, so adapt `call` to that signature. crm.vat.list returns all
// rates in one page (the seeded test portal has a handful), so a single call is complete
// here — production pages via the SDK's callList.make.
const listCall = async (method, params) => {
  const r = await call(method, params)
  return Array.isArray(r) ? r : []
}

// A supplier taxId that exists in the seeded portal (crm.requisite RQ_INN) so the
// company match succeeds; adjust to a value present on your portal.
const SUPPLIER_TAX_ID = '7712345678'

const CRAFTED = {
  documentType: DOC_TYPE,
  currency: 'BYN',
  priceIncludesVat: false,
  supplier: { name: 'ООО «Тест-Поставщик»', taxId: SUPPLIER_TAX_ID, taxIdKind: 'INN' },
  items: [
    { name: 'Кабель ВВГ 3х2.5', article: 'KAB-325', quantity: 500, unit: 'м', price: 1.20, vatRate: 20 },
    { name: 'Автомат С16', article: 'AVT-C16', quantity: 30, unit: 'шт', price: 4.50, vatRate: 20 }
  ]
}

const DOC_TEXT = [
  'ТОВАРНАЯ НАКЛАДНАЯ № ТН-2026-777 от 14.07.2026',
  `Поставщик: ООО «Тест-Поставщик»  ИНН: ${SUPPLIER_TAX_ID}`,
  'Наименование | Артикул | Кол-во | Ед. | Цена | Сумма',
  'Кабель ВВГ 3х2.5 | KAB-325 | 500 | м | 1.20 | 600.00',
  'Автомат С16 | AVT-C16 | 30 | шт | 4.50 | 135.00',
  'Итого: 735.00', 'НДС 20%: 147.00', 'Всего к оплате: 882.00', 'Валюта: BYN'
].join('\n')

async function extractWithAi(text) {
  // Preferred: the NEW chat engine (AGENT_ENGINE=chat) — the production path after #223. Uses the
  // real runChatExtract → makeChatFn against an OpenAI-compatible provider (DeepSeek/BitrixGPT),
  // so this E2E exercises exactly what the worker runs. Provider + key come from env (LLM_PROVIDER
  // + DEEPSEEK_API_KEY / VIBE_API_KEY). Returns a validated ExtractedDocument.
  if (resolveAgentEngine(process.env.AGENT_ENGINE) === 'chat') {
    const cfg = resolveLlmConfig(process.env)
    if (!cfg.apiKey) throw new Error(`нет ключа для провайдера '${cfg.label}' (задай DEEPSEEK_API_KEY / VIBE_API_KEY)`)
    console.log(`extract: chat engine · provider=${cfg.label} model=${cfg.model}`)
    const out = await runChatExtract(
      { documentText: text, instructions: buildExtractionPrompt(), model: cfg.model },
      { chat: makeChatFn(cfg), sleep: ms => new Promise(r => setTimeout(r, ms)), random: () => Math.random() }
    )
    if (!out.ok || !out.document) throw new Error(out.error || 'chat extract failed')
    return out.document
  }
  // Legacy claude/anthropic path (reads .env ANTHROPIC_*) — removed after the chat cutover.
  const BASE = readEnv('.env', 'ANTHROPIC_BASE_URL')
  const KEY = readEnv('.env', 'ANTHROPIC_AUTH_TOKEN')
  const r = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-chat', max_tokens: 1500, system: buildExtractionPrompt(), messages: [{ role: 'user', content: text }] })
  })
  const j = await r.json()
  const raw = j.content.map(c => c.text).join('')
  return JSON.parse(raw.replace(/^```json\s*|\s*```$/g, ''))
}

const mapping = {
  article: { field: 'PROPERTY_ARTICLE', kind: 'text' },
  product: { by: 'name', onMissing: 'freeform' },
  units: { dictionary: { шт: 796, м: 6 }, defaultCode: 796, autoCreate: false },
  saveFile: false,
  routingRules: [
    { match: { type: 'накладная' }, target: { entityTypeId: 2, categoryId: 1 } },
    { match: { type: 'счёт' }, target: { entityTypeId: 31 } }
    // КП/7 removed — not a supported target (no idempotency marker field), #135.
  ],
  defaultTarget: { entityTypeId: 2, categoryId: 0 }
}

// Idempotency is now a B24 marker (originId/xmlId) searched pre-create — wire the real lookup so
// the live run exercises it. Capture the created entity in the createTarget wrapper so cleanup
// runs even if a later step (setRows) throws before runCrmSync returns — no leaked [TEST] entity.
let created = null
const deps = {
  findExisting: (etid, filter) => findExistingItemId(etid, filter, call),
  findCompanyByTaxId: t => findCompanyByTaxId(t, call),
  findProduct: it => findProduct(it, mapping, call),
  portalVatRates: () => fetchVatRates(listCall),
  portalCurrencies: () => fetchCurrencies(call),
  createTarget: async (t, f) => {
    const entityId = await createTargetItem(t, f, call)
    created = { entityTypeId: t.entityTypeId, entityId }
    return entityId
  },
  setRows: (e, i, r) => setProductRows(e, i, r, call),
  reportErrors: async m => console.log('  ⚠ errors →', m),
  notifySuccess: async s => console.log('  ✓ notifySuccess', JSON.stringify(s))
}

// --type applies to the CRAFTED path only; in --ai mode the extracted documentType wins
// (that's the point of the AI path), so warn if both were passed to avoid a misleading run.
if (useAi && typeArg) console.log(`  ⚠ --type "${typeArg}" ignored in --ai mode (extracted documentType routes)`)

const doc = useAi ? await extractWithAi(DOC_TEXT) : CRAFTED
if (useAi) console.log('extracted:', JSON.stringify({ type: doc.documentType, currency: doc.currency, taxId: doc.supplier?.taxId, items: doc.items.length, priceIncludesVat: doc.priceIncludesVat }))

// Print which route this run actually exercises — a verification script must be honest about
// the path taken, so an unrecognized/typo'd type (→ defaultTarget, a deal) can't be mistaken
// for the smart-invoice (xmlId) path it was meant to test.
const matchedRule = mapping.routingRules.find(r => r.match.type === doc.documentType)
const chosen = matchedRule ? matchedRule.target : mapping.defaultTarget
console.log(`route: documentType="${doc.documentType}" → entityTypeId ${chosen.entityTypeId}${chosen.categoryId != null ? ` (categoryId ${chosen.categoryId})` : ''}${matchedRule ? '' : ' [defaultTarget — тип не сматчен]'}`)

try {
  const res = await runCrmSync('live-' + Math.floor(Date.now() / 1000), doc, mapping, { documentType: doc.documentType, text: DOC_TEXT }, deps)
  console.log('runCrmSync:', JSON.stringify(res))
  if (res.entityId) {
    const { item } = await call('crm.item.get', { entityTypeId: res.entityTypeId, id: res.entityId })
    console.log('entity:', JSON.stringify({ entityTypeId: res.entityTypeId, id: item.id, title: item.title, categoryId: item.categoryId, companyId: item.companyId, currencyId: item.currencyId, opportunity: item.opportunity }))
  }
} finally {
  // Always clean up the created entity (even on a mid-run failure), unless --keep.
  if (created && keep) {
    console.log('kept (--keep):', created.entityTypeId, created.entityId)
  } else if (created) {
    await call('crm.item.delete', { entityTypeId: created.entityTypeId, id: created.entityId }).catch(e => console.log('  cleanup failed:', e.message))
    console.log('cleanup: deleted', created.entityTypeId, created.entityId)
  }
}
