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
//   pnpm live:crm --no-taxid  # supplier WITHOUT a tax id → the fallback title branch (#440)
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
import { supplierNameTrusted } from '../app/utils/importTitle.ts'
import { assertTestPortal } from './lib/testPortalGuard.mjs'
import { loadLlmEnv } from './lib/llmEnv.mjs'

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
// #440: прогон ЗАПАСНОЙ ветки заголовка. По умолчанию у поставщика есть налоговый номер, и
// заголовок всегда берёт его название — то есть вживую наблюдалась ровно одна ветка из двух, а
// вторая (номер не распознан → «Импорт: <тип> на <сумма>») существовала только в юнит-тестах.
// Именно она несёт риск: сумма берётся НЕ из печатного итога документа, а из той, что реально
// уйдёт в запись, и тип сверяется с закрытым списком.
const noTaxId = args.has('--no-taxid')

const readEnv = (file, key) => {
  // Anchor to line start (^…$ with the m flag) so a commented `#KEY=…` or a longer
  // variable ending with KEY can't be captured; strip surrounding quotes.
  const m = readFileSync(file, 'utf8').match(new RegExp(`^\\s*${key}=(.+)$`, 'm'))
  if (!m) throw new Error(`${key} not found in ${file}`)
  return m[1].trim().replace(/^["']|["']$/g, '')
}
const WEBHOOK = readEnv('.env.b24test', 'B24_TEST_WEBHOOK')
assertTestPortal(WEBHOOK)

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
  supplier: noTaxId ? { name: 'ООО «Тест-Поставщик»' } : { name: 'ООО «Тест-Поставщик»', taxId: SUPPLIER_TAX_ID, taxIdKind: 'INN' },
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
  noTaxId ? 'Поставщик: ООО «Тест-Поставщик»' : `Поставщик: ООО «Тест-Поставщик»  ИНН: ${SUPPLIER_TAX_ID}`,
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
  loadLlmEnv()
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
    // #440: the title is the record's NAME IN THE CLIENT'S CRM FOREVER, so assert its form rather
    // than print it. Trusted branch → the supplier's own name; no tax id → «Импорт: <тип> на
    // <сумма>», where the sum is the one that actually reached the record (`opportunity`), NOT the
    // document's printed total — those diverge by design on a net invoice.
    // ⚠ Утверждается НЕСУЩЕЕ свойство, а не форма строки. Пересобрать здесь ожидаемый заголовок
    // из тех же `toLocaleString`/типа/валюты значило бы переписать `buildImportTitle` вторым
    // экземпляром — и на `--type акт` проверка ЛОЖНО падала бы при исправном проде: «акт» вне
    // закрытого списка типов, прод пишет «документ». В `--ai` то же самое даёт любой
    // documentType от модели вне списка («товарная накладная»).
    //
    // ⚠ Сверять при этом есть что и помимо формы: `item.opportunity` приходит С ПОРТАЛА, поэтому
    // сравнение числа из заголовка с ним — не тавтология. Именно оно ловит подмену
    // `recordTotal → doc.total`, ради которой заголовок и берёт ушедшую в запись сумму.
    // ⚠ Ветку ожидания выбирает СОСТОЯНИЕ ДОКУМЕНТА, а не флаг командной строки. Флаг лишь
    // собирает фикстуру без номера; какую ветку возьмёт прод, решает то, что вернула модель. В
    // `--ai --no-taxid` она вправе выдумать `taxId` из номера накладной — прод честно уйдёт в
    // доверенную ветку и напишет имя, а сверка по флагу объявила бы это дефектом, то есть красным
    // при исправном коде.
    const trusted = Boolean(supplierNameTrusted(doc))
    // ⚠ Флаг при этом не выброшен, а работает ПЕРЕКРЁСТНОЙ проверкой: сам `supplierNameTrusted`
    // тоже может быть сломан, и тогда обе стороны съехали бы вместе — «всегда null» превратил бы
    // утверждение «имя не утекло» в самоисполняющееся. На крафченой фикстуре состояние документа
    // известно точно, поэтому расхождение с флагом — отказ. В `--ai` оно законно (модель вправе
    // выдумать номер из номера накладной), там это предупреждение.
    if (noTaxId && trusted) {
      const msg = '#440: флаг --no-taxid, а документ считается доверенным (налоговый номер есть)'
      if (!useAi) throw new Error(msg)
      console.log(`  ⚠ ${msg} — модель вернула номер; проверяем доверенную ветку`)
    }
    if (!noTaxId && !trusted) throw new Error('#440: номер в фикстуре есть, а документ доверенным не считается')
    const supplierName = (doc.supplier?.name ?? '').trim()
    // ⚠ Пустое имя НЕ считается «имени в заголовке нет»: `includes('')` истинно всегда, то есть
    // молчаливо пропустило бы утечку. В доверенной ветке это отказ самой фикстуры.
    if (!supplierName && trusted) throw new Error('#440: в документе нет названия поставщика — проверять нечего')
    const nameInTitle = Boolean(supplierName) && item.title.includes(supplierName)
    if (!trusted && nameInTitle) throw new Error(`#440: номер не распознан, а название поставщика всё равно в заголовке — «${item.title}»`)
    if (trusted && !nameInTitle) throw new Error(`#440: номер распознан, но названия поставщика в заголовке нет — «${item.title}»`)
    if (!trusted) {
      // Запасной заголовок обязан быть различим в списке сделок: «Импорт: документ» без суммы —
      // ровно та строка, ради ухода от которой в него кладут тип и сумму. Проверка «есть цифра»
      // была бы почти пустой: её прошёл бы и заголовок с ЧУЖИМ числом. Нормализуем разделители
      // (`ru-RU` разделяет тысячи НЕРАЗРЫВНЫМ пробелом U+00A0) и сверяем с суммой записи.
      const shown = item.title.match(/\d[\d\s\u00a0\u202f]*(?:[.,]\d+)?/)
      if (!shown) throw new Error(`#440: запасной заголовок без суммы — «${item.title}»`)
      const num = Number(shown[0].replace(/[\s\u00a0\u202f]/g, '').replace(',', '.'))
      if (Math.abs(num - Number(item.opportunity)) > 0.01) {
        throw new Error(`#440: в заголовке сумма ${num}, а в записи ${item.opportunity} — «${item.title}»`)
      }
    }
    console.log(`✓ заголовок записи — ${!trusted ? 'запасной, без названия поставщика, сумма сходится с записью' : 'название поставщика (номер распознан)'}: «${item.title}»`)

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
    // the grid prints, so that column must equal the document's own price — in BOTH directions.
    // Sums alone cannot catch a regression here: flipping the flag leaves every total identical
    // and only changes the printed number, which is exactly the complaint (#347: operator read
    // 1,032 against a document printing 0,860).
    // Rows are matched to document items BY `sort` (the builder stamps (i+1)*10), not by the order
    // the portal happened to return them in — and only when every line was written, since a
    // skip-warn drop shifts the pairing and would compare unrelated rows.
    // ⚠ The crafted documents in this script are all net-priced, so the 'Y' side of this check is
    // written but NOT exercised by `pnpm live:crm` today — it guards the day one is added.
    // A discount line is BY DESIGN not representable in rows (negative price clamps to 0, the
    // header keeps the discount — crmSyncCore), so Σ rows > opportunity is correct there: skip.
    const hasDiscount = doc.items.some(i => Number(i.price) < 0)
    if (rows.length === doc.items.length) {
      // Which stored number the grid prints, and therefore which one must equal the paper:
      // 'N' → priceExclusive (net document), 'Y' → priceBrutto (VAT-inclusive document).
      const wantFlag = doc.priceIncludesVat ? 'Y' : 'N'
      const shown = r => Number(doc.priceIncludesVat ? r.priceBrutto : r.priceExclusive)
      const ordered = [...rows].sort((a, b) => Number(a.sort) - Number(b.sort))
      const off = ordered
        .map((r, i) => ({ i, want: Number(doc.items[i]?.price), got: shown(r) }))
        // A discount line is written clamped to 0 while the document keeps it negative — comparing
        // it here would fail on a correct import. Everything else must match to the kopeck.
        .filter(x => Number.isFinite(x.want) && x.want >= 0 && Math.abs(x.got - x.want) > 0.005)
      const flags = rows.map(r => r.taxIncluded)
      if (flags.every(f => f === wantFlag) && !off.length) {
        console.log(`✓ в колонке «Цена» портал покажет цены документа (taxIncluded=${wantFlag}, ${doc.priceIncludesVat ? 'priceBrutto' : 'priceExclusive'} = цена из документа)`)
      } else {
        throw new Error(`колонка «Цена» разошлась с документом: ожидали флаг ${wantFlag}, получили ${flags.join(',')}; расхождения=${JSON.stringify(off)}`)
      }
    }
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
