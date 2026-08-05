// Посев тестового портала под живой заход (`docs/PROJECT_MAP.md` §12.1, блок 0).
//
// ⚠ Зачем скрипт, если данные «остаются от прошлых прогонов»: на портале `b24-hrbvzq` их НЕ БЫЛО.
// Каждый `pnpm live:crm` печатал «Контрагент … не найден — запись создана без привязки к компании»,
// и это читалось как штатное сообщение, хотя означало ровно обратное: **счастливый путь подбора
// контрагента ни разу не наблюдался вживую**. Так же с артикулом — в инфоблоке каталога вообще не
// было свойства под него, то есть приоритетная ветка `findProduct` не могла сработать в принципе.
// Оба пути покрыты юнит-тестами, и оба до сих пор были 🧪, а не ✅.
//
// ⚠ Идемпотентен: ищет по `xmlId`/артикулу и обновляет, а не плодит копии. Повторный прогон обязан
// быть безопасным — иначе после третьего запуска на портале десяток одинаковых «Тест-Поставщиков»,
// и `findCompanyByTaxId` начинает выбирать из дублей, то есть проверка портит ровно то, что готовит.
//
//   pnpm seed:b24            # завести/обновить
//   pnpm seed:b24 --clean    # снести засеянное (компании, товары; свойство каталога остаётся)
//
// Свойство каталога `--clean` НЕ удаляет намеренно: к нему привязаны значения у товаров, которых
// скрипт мог не заводить, и удаление свойства стёрло бы чужие данные заодно.

import { readEnvValue } from './lib/envFile.mjs'
import { makeCall } from './lib/testPortal.mjs'
import { assertTestPortal } from './lib/testPortalGuard.mjs'

const WEBHOOK = readEnvValue('.env.b24test', 'B24_TEST_WEBHOOK')
assertTestPortal(WEBHOOK)
const call = makeCall(WEBHOOK)
const clean = process.argv.includes('--clean')

// Значения совпадают с фикстурой `live-crm-sync.mjs` — иначе посев готовит не то, что проверяется.
const SUPPLIER = { name: 'ООО «Тест-Поставщик»', taxId: '7712345678' }
const XML_ID = 'AIPI_SEED_SUPPLIER'
const NO_RQ_TITLE = '[TEST] Поставщик без реквизитов'
const NO_RQ_XML = 'AIPI_SEED_SUPPLIER_NO_RQ'
const PRODUCTS = [
  { name: '[TEST] Кабель ВВГ 3х2.5', article: 'KAB-325', price: 1.2 },
  { name: '[TEST] Автомат С16', article: 'AVT-C16', price: 4.5 },
  { name: '[TEST] Провод ПВС 2х1.5', article: 'PVS-215', price: 0.8654 }
]
const PRODUCT_XML_PREFIX = 'AIPI_SEED_'

/** Инфоблок товаров портала (у каталога торговых предложений заполнен `productIblockId`). */
async function productIblockId() {
  const { catalogs } = await call('catalog.catalog.list', { select: ['id', 'iblockId', 'productIblockId'] })
  const offers = (catalogs ?? []).find(c => c.productIblockId)
  const id = offers?.productIblockId ?? (catalogs ?? [])[0]?.iblockId
  if (!id) throw new Error('на портале нет каталога товаров')
  return id
}

/**
 * Свойство под артикул: найти по коду либо завести.
 *
 * ⚠ Ищем по `code`, а не по имени: имя админ вправе переименовать, и повторный прогон завёл бы
 * второе свойство «Артикул» — тогда в настройках приложения два одинаковых пункта, и выбранный
 * наугад не совпадёт с тем, в который писал посев.
 */
async function ensureArticleProperty(iblockId) {
  const { productProperties } = await call('catalog.productProperty.list', {
    filter: { iblockId }, select: ['id', 'code', 'name']
  })
  const found = (productProperties ?? []).find(p => p.code === 'ARTICLE')
  if (found) return found.id
  const { productProperty } = await call('catalog.productProperty.add', {
    fields: { iblockId, name: 'Артикул', code: 'ARTICLE', propertyType: 'S', multiple: 'N', isRequired: 'N' }
  })
  console.log(`  + свойство «Артикул» заведено (id ${productProperty.id})`)
  return productProperty.id
}

/**
 * Поиск компании по ТОЧНОМУ имени.
 *
 * ⚠ Не по `xmlId`, хотя он и записывается: `crm.item.list` фильтр по нему ОТВЕРГАЕТ
 * (`field 'XML_ID' is not allowed in filter`), а `crm.company.list` — молча ИГНОРИРУЕТ и отдаёт
 * весь список. Второе хуже отказа: поиск «нашёл бы» первую попавшуюся компанию портала, посев решил
 * бы, что всё на месте, и не завёл бы ничего — а живая проверка искала бы контрагента, которого нет.
 * `=title` фильтрует по-настоящему — проверено на портале в обе стороны.
 */
async function findCompanyByTitle(title) {
  const { items } = await call('crm.item.list', { entityTypeId: 4, filter: { '=title': title }, select: ['id', 'title'] })
  return (items ?? [])[0] ?? null
}

async function ensureCompany({ title, xmlId }) {
  const found = await findCompanyByTitle(title)
  if (found) return { id: found.id, created: false }
  const { item } = await call('crm.item.add', { entityTypeId: 4, fields: { title, xmlId } })
  return { id: item.id, created: true }
}

/**
 * Реквизит с налоговым номером — то, по чему приложение и ищет контрагента.
 *
 * ⚠ Номер живёт в `RQ_INN` реквизита, а НЕ в поле компании: `findCompanyByTaxId` читает
 * `crm.requisite.list`. Компания без реквизита выглядит заведённой, а подбор её не находит — ровно
 * то состояние, в котором портал и был.
 */
async function ensureRequisite(companyId, { name, taxId }) {
  const list = await call('crm.requisite.list', {
    filter: { ENTITY_TYPE_ID: 4, ENTITY_ID: companyId }, select: ['ID', 'RQ_INN']
  })
  const existing = (list ?? [])[0]
  const fields = { RQ_COMPANY_NAME: name, RQ_INN: taxId, NAME: name }
  if (existing) {
    await call('crm.requisite.update', { id: existing.ID, fields })
    return { id: existing.ID, created: false }
  }
  const presets = await call('crm.requisite.preset.list', {})
  const preset = (presets ?? []).find(p => p.NAME === 'Организация') ?? (presets ?? [])[0]
  if (!preset) throw new Error('на портале нет пресетов реквизитов')
  const id = await call('crm.requisite.add', {
    fields: { ENTITY_TYPE_ID: 4, ENTITY_ID: companyId, PRESET_ID: preset.ID, ...fields }
  })
  return { id, created: true }
}

async function ensureProduct(p, propertyId) {
  const xmlId = PRODUCT_XML_PREFIX + p.article
  const found = await call('crm.product.list', { filter: { XML_ID: xmlId }, select: ['ID'] })
  const fields = { NAME: p.name, XML_ID: xmlId, PRICE: p.price, CURRENCY_ID: 'BYN', ACTIVE: 'Y', [`PROPERTY_${propertyId}`]: p.article }
  if ((found ?? [])[0]) {
    await call('crm.product.update', { id: found[0].ID, fields })
    return { id: found[0].ID, created: false }
  }
  const id = await call('crm.product.add', { fields })
  return { id, created: true }
}

async function removeSeeded() {
  for (const title of [`[TEST] ${SUPPLIER.name}`, NO_RQ_TITLE]) {
    const c = await findCompanyByTitle(title)
    if (c) {
      await call('crm.item.delete', { entityTypeId: 4, id: c.id })
      console.log(`  − компания ${c.id} (${title})`)
    }
  }
  for (const p of PRODUCTS) {
    const found = await call('crm.product.list', { filter: { XML_ID: PRODUCT_XML_PREFIX + p.article }, select: ['ID'] })
    for (const row of found ?? []) {
      await call('crm.product.delete', { id: row.ID })
      console.log(`  − товар ${row.ID} (${p.article})`)
    }
  }
  console.log('\n✅ засеянное убрано (свойство каталога оставлено — см. шапку скрипта)')
}

if (clean) {
  console.log('уборка засеянного…')
  await removeSeeded()
} else {
  const iblockId = await productIblockId()
  console.log(`инфоблок товаров: ${iblockId}`)
  const propertyId = await ensureArticleProperty(iblockId)
  console.log(`свойство артикула: PROPERTY_${propertyId}`)

  const supplier = await ensureCompany({ title: `[TEST] ${SUPPLIER.name}`, xmlId: XML_ID })
  const rq = await ensureRequisite(supplier.id, SUPPLIER)
  console.log(`компания-поставщик: ${supplier.id} (${supplier.created ? 'заведена' : 'уже была'}), реквизит ${rq.id} (${rq.created ? 'заведён' : 'обновлён'}), УНП/ИНН ${SUPPLIER.taxId}`)

  const noRq = await ensureCompany({ title: NO_RQ_TITLE, xmlId: NO_RQ_XML })
  console.log(`компания без реквизитов: ${noRq.id} (${noRq.created ? 'заведена' : 'уже была'}) — путь «контрагент не найден»`)

  for (const p of PRODUCTS) {
    const r = await ensureProduct(p, propertyId)
    console.log(`товар ${r.id} (${r.created ? 'заведён' : 'обновлён'}): ${p.article} — ${p.name}`)
  }

  // Проверка ОБРАТНЫМ чтением тем же способом, каким ищет приложение: посев, который «прошёл», но
  // ничего не находит, хуже отсутствующего — он создаёт уверенность там, где её нет.
  const back = await call('crm.requisite.list', { filter: { RQ_INN: SUPPLIER.taxId }, select: ['ID', 'ENTITY_ID', 'ENTITY_TYPE_ID'] })
  const hit = (back ?? []).find(r => String(r.ENTITY_TYPE_ID) === '4' && String(r.ENTITY_ID) === String(supplier.id))
  if (!hit) throw new Error(`посев не читается обратно: реквизита с RQ_INN=${SUPPLIER.taxId} у компании ${supplier.id} не нашлось`)
  console.log(`\n✓ обратное чтение: RQ_INN ${SUPPLIER.taxId} → компания ${supplier.id}`)
  console.log('\n✅ портал засеян. Дальше: `pnpm live:crm` — привязка к компании и подбор по артикулу')
  console.log('   ⚠ в настройках приложения выберите свойство артикула — «Артикул» (иначе подбор пойдёт по имени)')
}
