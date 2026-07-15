// Live end-to-end check of the document→CRM happy path against a real test portal.
// Dev-only (like seed:b24). Runs the REAL crm-sync (server/queue/crmSyncCore) with a
// webhook-backed RestCall, routing by document type: накладная→deal / счёт→smart-invoice /
// КП→quote. Optionally runs the DeepSeek extraction first.
//
//   pnpm live:crm            # crafted doc → runCrmSync → verify → delete
//   pnpm live:crm --ai       # document TEXT → DeepSeek → runCrmSync → verify → delete
//   pnpm live:crm --keep     # do not delete the created entity
//
// Reads git-ignored env: .env.b24test (B24_TEST_WEBHOOK) and, with --ai, .env
// (ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN). Creates then deletes a [TEST] entity.
import { readFileSync } from 'node:fs'
import { buildExtractionPrompt } from '../prompts/extract.ts'
import { runCrmSync } from '../server/queue/crmSyncCore.ts'
import { findCompanyByTaxId } from '../server/utils/companyLookup.ts'
import { findProduct } from '../server/utils/productLookup.ts'
import { fetchVatRates } from '../server/utils/portalVat.ts'
import { fetchCurrencies } from '../server/utils/portalCurrency.ts'
import { createTargetItem, setProductRows } from '../server/utils/crmWrite.ts'

const args = new Set(process.argv.slice(2))
const useAi = args.has('--ai')
const keep = args.has('--keep')

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
  documentType: 'накладная',
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
    { match: { type: 'счёт' }, target: { entityTypeId: 31 } },
    { match: { type: 'КП' }, target: { entityTypeId: 7 } }
  ],
  defaultTarget: { entityTypeId: 2, categoryId: 0 }
}

// Capture the created entity as soon as runCrmSync checkpoints it, so cleanup runs even
// if a later step (setRows) throws before runCrmSync returns — no leaked [TEST] entity.
let created = null
const deps = {
  getExisting: async () => null,
  findCompanyByTaxId: t => findCompanyByTaxId(t, call),
  findProduct: it => findProduct(it, mapping, call),
  portalVatRates: () => fetchVatRates(listCall),
  portalCurrencies: () => fetchCurrencies(call),
  createTarget: (t, f) => createTargetItem(t, f, call),
  setRows: (e, i, r) => setProductRows(e, i, r, call),
  recordResult: async (_jobId, entityTypeId, entityId) => { created = { entityTypeId, entityId } },
  reportErrors: async m => console.log('  ⚠ errors →', m),
  notifySuccess: async s => console.log('  ✓ notifySuccess', JSON.stringify(s))
}

const doc = useAi ? await extractWithAi(DOC_TEXT) : CRAFTED
if (useAi) console.log('extracted:', JSON.stringify({ type: doc.documentType, currency: doc.currency, taxId: doc.supplier?.taxId, items: doc.items.length, priceIncludesVat: doc.priceIncludesVat }))

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
