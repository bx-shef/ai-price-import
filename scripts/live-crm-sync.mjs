// Live end-to-end check of the document→CRM happy path against a real test portal.
// Dev-only (like seed:b24). Runs the REAL crm-sync (server/queue/crmSyncCore) with a
// webhook-backed RestCall, routing by document type: накладная→deal / счёт→smart-invoice /
// акт→dynamic smart process (КП/quote removed — no idempotency marker field, #135). Optionally
// runs the DeepSeek extraction first.
//
//   pnpm live:crm             # crafted накладная → deal (entityTypeId 2) → verify → delete
//   pnpm live:crm --type счёт  # crafted счёт → smart-invoice (entityTypeId 31, xmlId marker)
//   pnpm live:crm --type акт   # crafted акт → dynamic smart process (env LIVE_SP_ETID, default 1120)
//   pnpm live:crm --ai        # document TEXT → chat extractor → runCrmSync → verify → delete
//   pnpm live:crm --keep      # do not delete the created entity
//
// `--type` exercises the routing table below: накладная→deal (originId marker) and
// счёт→smart-invoice (xmlId marker) are DISTINCT idempotency code paths, so both are worth a
// live run. Reads git-ignored env: .env.b24test (B24_TEST_WEBHOOK) and, with --ai, the LLM
// provider from env (LLM_PROVIDER + DEEPSEEK_API_KEY / VIBE_API_KEY). Creates then deletes a [TEST] entity.
import { readFileSync } from 'node:fs'
import { buildExtractionPrompt } from '../prompts/extract.ts'
import { runCrmSync } from '../server/queue/crmSyncCore.ts'
import { resolveLlmConfig } from '../server/agent/llmConfig.ts'
import { makeChatFn } from '../server/agent/openaiChat.ts'
import { runChatExtract } from '../server/agent/chatExtract.ts'
import { findCompanyByTaxId } from '../server/utils/companyLookup.ts'
import { findProduct } from '../server/utils/productLookup.ts'
import { fetchVatRates } from '../server/utils/portalVat.ts'
import { fetchCurrencies } from '../server/utils/portalCurrency.ts'
import { createTargetItem, ownerTypeCode, setProductRows } from '../server/utils/crmWrite.ts'
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

// The item set deliberately covers the row-write edge cases of #302: a plain 2-dp net line, a
// SUB-KOPECK unit price with a FRACTIONAL quantity (0.8654 × 12.345 — per-metre pricing; both
// must reach the portal at document precision, not kopeck-rounded), and a «Без НДС» line
// (vatRate 0 → taxRate null → price written unconverted).
const CRAFTED = {
  documentType: DOC_TYPE,
  currency: 'BYN',
  priceIncludesVat: false,
  supplier: { name: 'ООО «Тест-Поставщик»', taxId: SUPPLIER_TAX_ID, taxIdKind: 'INN' },
  items: [
    { name: 'Кабель ВВГ 3х2.5', article: 'KAB-325', quantity: 500, unit: 'м', price: 1.20, vatRate: 20 },
    { name: 'Автомат С16', article: 'AVT-C16', quantity: 30, unit: 'шт', price: 4.50, vatRate: 20 },
    { name: 'Провод ПВС 2х1.5', article: 'PVS-215', quantity: 12.345, unit: 'м', price: 0.8654, vatRate: 20 },
    { name: 'Доставка', article: 'DLV-1', quantity: 1, unit: 'шт', price: 50, vatRate: 0 }
  ]
}

// Printed totals follow document arithmetic (per-line net rounded to kopecks, VAT per line):
// 600.00 + 135.00 + round2(0.8654×12.345)=10.68 + 50.00 = 795.68; НДС 120+27+2.14+0 = 149.14.
const DOC_TEXT = [
  'ТОВАРНАЯ НАКЛАДНАЯ № ТН-2026-777 от 14.07.2026',
  `Поставщик: ООО «Тест-Поставщик»  ИНН: ${SUPPLIER_TAX_ID}`,
  'Наименование | Артикул | Кол-во | Ед. | Цена | Сумма',
  'Кабель ВВГ 3х2.5 | KAB-325 | 500 | м | 1.20 | 600.00',
  'Автомат С16 | AVT-C16 | 30 | шт | 4.50 | 135.00',
  'Провод ПВС 2х1.5 | PVS-215 | 12.345 | м | 0.8654 | 10.68',
  'Доставка | DLV-1 | 1 | шт | 50.00 | 50.00',
  'Итого: 795.68', 'НДС 20%: 149.14', 'Всего к оплате: 944.82', 'Валюта: BYN'
].join('\n')

async function extractWithAi(text) {
  // The production extractor path: runChatExtract → makeChatFn against an OpenAI-compatible provider
  // (DeepSeek/BitrixGPT), exactly what the worker runs. Provider + key from env (LLM_PROVIDER +
  // DEEPSEEK_API_KEY / VIBE_API_KEY). Returns a validated ExtractedDocument.
  const cfg = resolveLlmConfig(process.env)
  if (!cfg.apiKey) throw new Error(`нет ключа для провайдера '${cfg.label}' (задай DEEPSEEK_API_KEY / VIBE_API_KEY)`)
  console.log(`extract: provider=${cfg.label} model=${cfg.model}`)
  const out = await runChatExtract(
    { documentText: text, instructions: buildExtractionPrompt(), model: cfg.model },
    { chat: makeChatFn(cfg), sleep: ms => new Promise(r => setTimeout(r, ms)), random: () => Math.random() }
  )
  if (!out.ok || !out.document) throw new Error(out.error || 'chat extract failed')
  return out.document
}

const mapping = {
  article: { field: 'PROPERTY_ARTICLE', kind: 'text' },
  product: { by: 'name', onMissing: 'freeform' },
  units: { dictionary: { шт: 796, м: 6 }, defaultCode: 796, autoCreate: false },
  saveFile: false,
  routingRules: [
    { match: { type: 'накладная' }, target: { entityTypeId: 2, categoryId: 1 } },
    { match: { type: 'счёт' }, target: { entityTypeId: 31 } },
    // Dynamic smart process (BACKLOG §1 «Живой проход в смарт-процесс»): xmlId marker path on a
    // portal-specific entityTypeId — override with env LIVE_SP_ETID (there is no --etid flag).
    // Default 1120 = «[TEST] СП с товарами (live)», created manually (crm.type.add,
    // isLinkWithProductsEnabled) and deliberately left on the test portal so the bare command works
    // out of the box; a type WITHOUT products answers ENTITY_TYPE_NOT_SUPPORTED on productrow.set.
    { match: { type: 'акт' }, target: { entityTypeId: Number(process.env.LIVE_SP_ETID || 1120) } }
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
    // #302: read the rows BACK and hold the invariant «Σ price×qty == сумма сущности». The old
    // check printed `opportunity` — the number WE set — so rows understated by the whole VAT
    // still passed as «live-verified». The portal computes the product tab from row `price`
    // alone (always gross; taxIncluded is computation-neutral — proven live), so this comparison
    // is exactly what a person sees: products tab vs deal header.
    const { productRows } = await call('crm.item.productrow.list', {
      filter: { '=ownerType': ownerTypeCode(res.entityTypeId), '=ownerId': res.entityId }
    })
    const rows = productRows ?? []
    for (const r of rows) console.log(`  row: ${JSON.stringify({ name: r.productName, price: r.price, qty: r.quantity, taxRate: r.taxRate, taxIncluded: r.taxIncluded, exclusive: r.priceExclusive })}`)
    const rowSum = Math.round(rows.reduce((s, r) => s + Number(r.price) * Number(r.quantity), 0) * 100) / 100
    const opp = Number(item.opportunity)
    console.log(`rows: ${rows.length}, Σ price×qty = ${rowSum}`)
    // #347: what the OPERATOR sees in the «Цена» column. `taxIncluded` picks which stored number
    // the grid prints — 'N' → priceExclusive — so for a net-priced document that column must equal
    // the document's own price. Sums alone cannot catch a regression here: flipping the flag back
    // to 'Y' leaves every total identical and only changes the printed number, which is exactly
    // the complaint (#347: operator read 1,032 against a document printing 0,860).
    if (!doc.priceIncludesVat) {
      const off = rows
        .map((r, i) => ({ i, want: Number(doc.items[i]?.price), got: Number(r.priceExclusive) }))
        .filter(x => Number.isFinite(x.want) && Math.abs(x.got - x.want) > 0.005)
      if (rows.every(r => r.taxIncluded === 'N') && !off.length) {
        console.log('✓ в колонке «Цена» портал покажет нетто-цены документа (taxIncluded=N, priceExclusive = цена из документа)')
      } else {
        throw new Error(`колонка «Цена» разошлась с документом: флаги=${rows.map(r => r.taxIncluded).join(',')} расхождения=${JSON.stringify(off)}`)
      }
    }
    // A discount line is BY DESIGN not representable in rows (negative price clamps to 0, the
    // header keeps the discount — crmSyncCore), so Σ rows > opportunity is correct there: skip.
    const hasDiscount = doc.items.some(i => Number(i.price) < 0)
    // Dynamic smart-processes may not expose opportunity at all (supportsOpportunity=false —
    // we don't set it, the portal may report 0/null there) — compare only when it is meaningful.
    if (hasDiscount) {
      console.log('  (скидочная строка клампится в 0 — сверка Σ строк с суммой сущности пропущена, by design)')
    } else if (Number.isFinite(opp) && opp > 0) {
      // Compare in WHOLE KOPECKS (float |a-b| > 0.01 is unreliable at ≥2048: |10319.99−10320|
      // computes to 0.01000000000021). Allowance: ±1 kopeck per line — lineGross rounds each
      // line's gross while the portal sums unrounded row products, a legitimate ± cent per line;
      // when the document STATED a total, reconcilePricing may anchor the header up to
      // min(max(0.5, 0.5/line), 1%) away from row arithmetic — mirror that slack.
      // NaN guard: a non-numeric row field would make rowSum NaN and any comparison false-pass.
      const rowSumC = Math.round(rowSum * 100)
      const oppC = Math.round(opp * 100)
      const allowanceC = doc.total != null
        ? Math.round(Math.min(Math.max(0.5, 0.5 * rows.length), opp * 0.01) * 100)
        : Math.max(1, rows.length)
      if (!Number.isFinite(rowSum) || Math.abs(rowSumC - oppC) > allowanceC) {
        throw new Error(`строки разошлись с суммой сущности: Σ строк ${rowSum} ≠ opportunity ${opp} (допуск ${allowanceC} коп.) — класс дефекта #302: запись строк расходится с шапкой`)
      }
      console.log(`✓ Σ строк сходится с суммой сущности (${opp}, допуск ${allowanceC} коп.)`)
    }
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
