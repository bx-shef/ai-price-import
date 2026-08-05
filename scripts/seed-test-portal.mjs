// Посев тестового портала под живой заход (`docs/PROJECT_MAP.md` §12.1, блок 0).
//
// ⚠ ТОЛЬКО ТЕСТОВЫЙ ПОРТАЛ. Скрипт меняет данные и схему: заводит компанию с реквизитом, товары и —
// если его нет — свойство каталога «Артикул». `--clean` УДАЛЯЕТ заведённое. Гард `assertTestPortal`
// пускает только на портал из белого списка; его обход (`--yes-target=<домен>`) для этого скрипта
// означает запись и удаление в чужой CRM, а свойство каталога не откатывается вовсе.
//
// ⚠ Зачем он нужен: на портале `b24-hrbvzq` этих данных НЕ БЫЛО, и заметить это было нечем. Каждый
// `pnpm live:crm` печатал «Контрагент … не найден — запись создана без привязки к компании», и это
// читалось как штатное сообщение, хотя означало обратное: счастливый путь подбора контрагента не
// наблюдался. Со свойством артикула хуже — его в каталоге не существовало, а обе ветки подбора
// БАЗОВОГО товара (свойство артикула → внешний код) сидят под одним гейтом `product.by === 'article'`,
// который в прогоне был зашит в `'name'`. (Приоритетная ветка `findProduct` — торговые предложения;
// она идёт до этого гейта и проверена отдельно 2026-08-02.)
//
//   pnpm seed:b24            # завести/обновить
//   pnpm seed:b24 --clean    # снести заведённое (компания, товары; свойство каталога остаётся)
//
// ⚠ `--clean` удаляет ЛЮБУЮ компанию с нашим налоговым номером, даже заведённую человеком. Это
// симметрично посеву («нашлась по нашему номеру ⇒ наша») и безопасно ровно потому, что номер
// заведомо фиктивный; на портале с настоящими контрагентами так делать нельзя.
//
// ⚠ Что `--clean` НЕ убирает и почему: свойство каталога (к нему могут быть привязаны значения
// чужих товаров) и СДЕЛКИ прошлых прогонов — удаление компании уносит её дела, а сделки остаются
// в воронке уже без компании. Живые прогоны чистят свои сделки сами; чужие мы не трогаем.

import { makeCall, readHook } from './lib/testPortal.mjs'
import { assertTestPortal } from './lib/testPortalGuard.mjs'
import { SEED_PRODUCTS, SEED_SUPPLIER, catalogNameFor, seedXmlId } from './lib/seedFixture.mjs'

// ⚠ Адрес берётся ТЕМ ЖЕ хелпером, что и у остальных живых скриптов. Своё чтение
// `B24_TEST_WEBHOOK` было четвёртой дорогой к порталу: разойдись два ключа в `.env.b24test` — посев
// и прогон уехали бы на РАЗНЫЕ порталы, и получилось бы ровно «часть проверок зелена, часть красна,
// и обе врут о причине».
const WEBHOOK = readHook('.env.b24test')
assertTestPortal(WEBHOOK)
const call = makeCall(WEBHOOK)
const clean = process.argv.includes('--clean')

const COMPANY_TITLE = `[TEST] ${SEED_SUPPLIER.name}`

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
 * Компания — по НАЛОГОВОМУ НОМЕРУ, то есть тем же ключом, каким её ищет приложение
 * (`findCompanyByTaxId` → `crm.requisite.list`).
 *
 * ⚠ Первая редакция искала по точному ИМЕНИ, и это было неверно дважды. Во-первых, имя вообще не
 * идентификатор: приложение по нему компанию не ищет никогда, поэтому «нашлось по имени» не значит
 * «приложение найдёт». Во-вторых — и это хуже — при совпадении имени посев ПЕРЕЗАПИСЫВАЛ бы
 * реквизит чужой компании: подменил бы `RQ_INN` у карточки, которую завёл человек. Тихая порча
 * чужих данных вместо честного «такой компании нет, завожу свою».
 * ⚠ По `xmlId` искать нельзя: `crm.item.list` фильтр по нему отвергает, `crm.company.list` — молча
 * игнорирует и отдаёт весь список, да и в `select` его не возвращает (проверено на портале).
 */
async function findCompanyByTaxId(taxId) {
  const rows = await call('crm.requisite.list', {
    filter: { RQ_INN: taxId }, select: ['ID', 'ENTITY_ID', 'ENTITY_TYPE_ID']
  })
  const rq = (rows ?? []).find(r => String(r.ENTITY_TYPE_ID) === '4')
  return rq ? { companyId: Number(rq.ENTITY_ID), requisiteId: rq.ID } : null
}

async function ensureSupplier() {
  const found = await findCompanyByTaxId(SEED_SUPPLIER.taxId)
  if (found) {
    // Найдена ПО НАШЕМУ номеру — значит она наша по определению, обновлять её безопасно.
    await call('crm.requisite.update', {
      id: found.requisiteId,
      fields: { RQ_COMPANY_NAME: SEED_SUPPLIER.name, RQ_INN: SEED_SUPPLIER.taxId }
    })
    return { ...found, created: false }
  }
  const { item } = await call('crm.item.add', { entityTypeId: 4, fields: { title: COMPANY_TITLE } })
  const presets = await call('crm.requisite.preset.list', {})
  const preset = (presets ?? []).find(p => p.NAME === 'Организация') ?? (presets ?? [])[0]
  if (!preset) throw new Error('на портале нет пресетов реквизитов')
  const requisiteId = await call('crm.requisite.add', {
    fields: {
      ENTITY_TYPE_ID: 4, ENTITY_ID: item.id, PRESET_ID: preset.ID,
      NAME: SEED_SUPPLIER.name, RQ_COMPANY_NAME: SEED_SUPPLIER.name, RQ_INN: SEED_SUPPLIER.taxId
    }
  })
  return { companyId: item.id, requisiteId, created: true }
}

/**
 * Товар — по ВНЕШНЕМУ КОДУ. Фильтр `crm.product.list` по `XML_ID` действительно фильтрует
 * (проверено на портале в обе стороны: своё значение → одна строка, несуществующее → пусто), в
 * отличие от компаний, где такой фильтр молча игнорируется.
 */
async function ensureProduct(p, propertyId) {
  const xmlId = seedXmlId(p.article)
  const found = await call('crm.product.list', { filter: { XML_ID: xmlId }, select: ['ID'] })
  const fields = {
    NAME: catalogNameFor(p.docName), XML_ID: xmlId, PRICE: p.price,
    CURRENCY_ID: 'BYN', ACTIVE: 'Y', [`PROPERTY_${propertyId}`]: p.article
  }
  if ((found ?? [])[0]) {
    await call('crm.product.update', { id: found[0].ID, fields })
    return { id: found[0].ID, created: false }
  }
  const id = await call('crm.product.add', { fields })
  return { id, created: true }
}

async function removeSeeded() {
  const found = await findCompanyByTaxId(SEED_SUPPLIER.taxId)
  if (found) {
    await call('crm.item.delete', { entityTypeId: 4, id: found.companyId })
    console.log(`  − компания ${found.companyId} (по налоговому номеру ${SEED_SUPPLIER.taxId})`)
  } else {
    console.log('  · компании с нашим налоговым номером нет')
  }
  for (const p of SEED_PRODUCTS) {
    const rows = await call('crm.product.list', { filter: { XML_ID: seedXmlId(p.article) }, select: ['ID'] })
    for (const row of rows ?? []) {
      await call('crm.product.delete', { id: row.ID })
      console.log(`  − товар ${row.ID} (${p.article})`)
    }
  }
  console.log('\n✅ заведённое убрано (свойство каталога и сделки прошлых прогонов остаются — см. шапку)')
}

if (clean) {
  console.log('уборка заведённого…')
  await removeSeeded()
} else {
  const iblockId = await productIblockId()
  const propertyId = await ensureArticleProperty(iblockId)
  console.log(`инфоблок товаров: ${iblockId}, свойство артикула: PROPERTY_${propertyId}`)

  const supplier = await ensureSupplier()
  console.log(`компания-поставщик: ${supplier.companyId} (${supplier.created ? 'заведена' : 'уже была'}), реквизит ${supplier.requisiteId}, УНП/ИНН ${SEED_SUPPLIER.taxId}`)

  for (const p of SEED_PRODUCTS) {
    const r = await ensureProduct(p, propertyId)
    console.log(`товар ${r.id} (${r.created ? 'заведён' : 'обновлён'}): ${p.article} — ${catalogNameFor(p.docName)}`)
  }

  // Обратное чтение ТЕМ ЖЕ способом, каким ищет приложение. Посев, который «прошёл», но ничего не
  // находит, хуже отсутствующего — он создаёт уверенность там, где её нет.
  const back = await findCompanyByTaxId(SEED_SUPPLIER.taxId)
  if (!back || back.companyId !== supplier.companyId) {
    throw new Error(`посев не читается обратно: по RQ_INN=${SEED_SUPPLIER.taxId} компания ${back?.companyId ?? 'не найдена'}, ожидалась ${supplier.companyId}`)
  }
  for (const p of SEED_PRODUCTS) {
    const rows = await call('crm.product.list', {
      filter: { [`%PROPERTY_${propertyId}`]: p.article, ACTIVE: 'Y' }, select: ['ID', 'NAME'], order: { ID: 'ASC' }
    })
    if (!(rows ?? []).length) throw new Error(`посев не читается обратно: товара с артикулом ${p.article} не нашлось`)
  }
  console.log(`\n✓ обратное чтение: номер ${SEED_SUPPLIER.taxId} → компания ${supplier.companyId}; все ${SEED_PRODUCTS.length} артикула находятся`)
  console.log('\n✅ портал засеян. Дальше: `pnpm live:crm` — привязка к компании и подбор по артикулу')
  console.log('   ⚠ в настройках приложения выберите свойство артикула — «Артикул» (иначе подбор пойдёт по имени)')
}
