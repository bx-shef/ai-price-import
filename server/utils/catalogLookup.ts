import type { RestCall } from './b24Rest'
import type { ArticleFieldConfig } from '~/types/mapping'
import { articleMatches, parseSupplierArticles } from '~/utils/supplierArticles'

// Shared core of catalog lookup for crm-sync: ONE implementation for base products and for trade
// offers (SKU / «торговые предложения»), parameterised by the REST method and the key its rows
// arrive under.
//
// ⚠ Why shared. The two paths were byte-for-byte the same logic in two files — narrow server-side,
// then confirm an EXACT article match client-side. Two copies of a rule this load-bearing drift:
// the offers copy already carried a live-found guard (the portal SILENTLY IGNORES a filter on a
// property the iblock does not have and returns the WHOLE list) that the product copy had only by
// luck of a different code path.
//
// ⚠ `crm.product.*` is DEPRECATED (owner, 2026-08-06 — the docs say so outright). The whole path is
// on `catalog.product.list` / `catalog.product.offer.list`, which are the current pair and, being
// siblings, take the same shapes: `iblockId` REQUIRED in the filter, `id`+`iblockId` REQUIRED in
// select, rows grouped under a method-specific key, property values as `{ value, valueId }` (or an
// array of those when the property is multiple), field names in lowerCamel (`xmlId`, `active`).
// That symmetry is exactly what lets one function serve both.

/** Which catalog list method to read, and the key its rows arrive under. */
export interface CatalogSource {
  method: 'catalog.product.list' | 'catalog.product.offer.list'
  listKey: 'products' | 'offers'
}

export const PRODUCT_SOURCE: CatalogSource = { method: 'catalog.product.list', listKey: 'products' }
export const OFFER_SOURCE: CatalogSource = { method: 'catalog.product.offer.list', listKey: 'offers' }

/**
 * Инфоблоки каталога: предложения и товары.
 *
 * Живёт здесь, а не в модуле пикера настроек: инфоблок нужен КАЖДОМУ запросу подбора (методы
 * `catalog.*` требуют `iblockId` в фильтре), то есть это часть ядра подбора, а не подробность
 * интерфейса. Пикер импортирует отсюда.
 */
export async function resolveIblocks(call: RestCall): Promise<{ offer: number | null, product: number | null }> {
  // The transport's `.call` (makeSdkRestCall) returns the UNWRAPPED `result`, so read
  // `catalogs` directly — NOT `result.catalogs` (that double-unwrap yields undefined in prod).
  // ⚠ Форм ответа ДВЕ: `{ catalogs: [...] }` и голый массив (наблюдалось на портале). Читать только
  // первую значило бы на таком портале не найти каталогов вовсе — и подбор молча выключился бы.
  const resp = await call('catalog.catalog.list', {}) as { catalogs?: Array<Record<string, unknown>> } | Array<Record<string, unknown>> | undefined
  const catalogs = (Array.isArray(resp) ? resp : resp?.catalogs) ?? []
  // Каталог предложений — тот, что УКАЗЫВАЕТ на родительский инфоблок товаров.
  const offers = catalogs.find(c => positiveInt(c.productIblockId))
  const main = catalogs.find(c => c.productIblockId == null) ?? catalogs[0]
  return {
    offer: offers ? positiveInt(offers.iblockId ?? offers.id) : null,
    // Родитель берётся у каталога предложений, если он есть: так связка «ТП → товар» точнее, чем
    // «первый каталог без productIblockId», когда каталогов несколько.
    product: (offers ? positiveInt(offers.productIblockId) : null) ?? (main ? positiveInt(main.iblockId ?? main.id) : null)
  }
}

/**
 * Найти активную запись каталога по ВНЕШНЕМУ КОДУ (`xmlId`), либо null.
 *
 * ⚠ РЕГИСТР СРАВНИВАЕТ БАЗА, А НЕ МЫ И НЕ API. Проверено вживую 06.08.2026 и подтверждено разбором
 * ядра (владелец): `xmlId` разбирается как фильтр типа `string`, и MySQL-ветка `CIBlock::FilterCreateEx`
 * строит голое `LIKE 'значение'` без `UPPER()` — сравнение целиком отдано СУБД, то есть коллации
 * колонки. Битрикс ставится с регистронезависимой коллацией, поэтому облако находит `zq-x` по
 * `ZQ-X`; коробка на двоичной коллации сравнивала бы с учётом регистра. Ни один префикс фильтра
 * режим не переключает (`=` тоже — живая проба вернула обе строки).
 *
 * ⚠ Отсюда — ЯВНАЯ отбраковка неоднозначности, а не `minId` по всему ответу. Живая проба: два
 * товара, `AIPI_CASE_PROBE` и `aipi_case_probe`, и КАЖДЫЙ из четырёх запросов (верхний, нижний,
 * вперемешку, с префиксом `=`) вернул ОБА. Прежний `minId` молча брал меньший id — то есть
 * документ с кодом `aipi_case_probe` получал в сделку товар `AIPI_CASE_PROBE`. Это не «не нашли»,
 * а «нашли не тот»: сумма сходится, статус «Готово», в карточке чужая позиция. Поэтому при
 * нескольких РАЗНЫХ написаниях кода среди ответа мы отвечаем «не подобрано» — свободная строка с
 * названием из документа честнее произвольного выбора.
 *
 * ⚠ ТЕРПИМОСТЬ К РЕГИСТРУ ОСТАВЛЕНА — И ЭТО РЕШЕНИЕ ВЛАДЕЛЬЦА (06.08.2026), А НЕ НЕДОДЕЛКА, для
 * облака И для коробки. Строгая сверка `===` на нашей стороне уравняла бы все установки бесплатно,
 * но отняла бы совпадения, которые сегодня работают: поставщик печатает `zq-1`, в каталоге лежит
 * `ZQ-1`. Плата за решение названа прямо: на коробке с двоичной коллацией такой документ не
 * подберётся, потому что портал не вернёт строку вовсе, — и это НЕ чинится на нашей стороне
 * (сворачивать нечего, ответ пуст). Не переписывать «для единообразия»: единообразие достигается
 * только ухудшением обеих установок.
 */
export async function findCatalogByXmlId(src: CatalogSource, xmlId: string, iblockId: number, call: RestCall): Promise<number | null> {
  const q = (xmlId ?? '').trim()
  if (!q || !iblockId) return null
  const rows = await listRows(src, { iblockId, xmlId: q, active: 'Y' }, ['id', 'iblockId', 'xmlId'], call)
  if (!rows.length) return null
  // Разные написания одного кода ⇒ выбор был бы произвольным. Не выбираем.
  const spellings = new Set(rows.map(r => String(r.xmlId ?? '')).filter(Boolean))
  if (spellings.size > 1) return null
  return minId(rows)
}

/**
 * Найти активную запись каталога по СВОЙСТВУ, хранящему артикул поставщика, либо null.
 *
 * ⚠ Сверка точного совпадения на клиенте ОБЯЗАТЕЛЬНА, и по двум независимым причинам.
 * (1) Сервер сужает подстрочным `%`-фильтром (точный не находит значение с несколькими
 *     артикулами: «A\nB» по запросу «A» не совпадает), и он же возвращает `ZQ-50` на запрос
 *     `ZQ-5` — отбраковка наша.
 * (2) Живая находка 05.08.2026: портал МОЛЧА игнорирует фильтр по свойству, которого в инфоблоке
 *     нет, и возвращает ВЕСЬ список. Без сверки первая строка каталога уехала бы в запись клиента
 *     как подобранный товар, и заметить это было бы нечем.
 */
export async function findCatalogByProperty(src: CatalogSource, article: string, cfg: ArticleFieldConfig, iblockId: number, call: RestCall): Promise<number | null> {
  const q = (article ?? '').trim()
  const propId = numericPropertyId(cfg.field)
  if (!q || !propId || !iblockId) return null
  const key = `property${propId}`
  // `order` по id делает (ограниченную порталом) страницу ответа детерминированной, чтобы
  // контракт «берём меньший id» держался внутри неё.
  const rows = await listRows(src, { iblockId, [`%${key}`]: q, active: 'Y' }, ['id', 'iblockId', key], call, { id: 'asc' })
  const matched = rows.filter(r => articleMatches(q, parseSupplierArticles(propertyValue(r[key]), cfg)))
  return minId(matched)
}

/** Один запрос к каталогу. `iblockId` обязателен и в фильтре, и в `select` — требование методов. */
async function listRows(src: CatalogSource, filter: Record<string, unknown>, select: string[], call: RestCall, order?: Record<string, string>): Promise<Array<Record<string, unknown>>> {
  const params: Record<string, unknown> = { filter, select }
  if (order) params.order = order
  const res = await call(src.method, params) as Record<string, unknown> | undefined
  const rows = res?.[src.listKey]
  return Array.isArray(rows) ? rows as Array<Record<string, unknown>> : []
}

/** `PROPERTY_130` / `130` → `130`. Символьный код отвергается: фильтр строится по числовому id. */
export function numericPropertyId(field: string): number | null {
  const f = (field ?? '').trim().replace(/^PROPERTY_/i, '')
  return /^\d+$/.test(f) ? Number(f) : null
}

/**
 * Значение свойства каталога строкой. Формы, наблюдавшиеся вживую: `{ value, valueId }`, массив
 * таких объектов (у множественного свойства) и голая строка. Части множественного склеиваются
 * переводом строки, чтобы текстовая форма поля (`kind: 'text'`) дала по артикулу на часть.
 */
export function propertyValue(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(propertyValue).filter(Boolean).join('\n')
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if ('value' in o) return String(o.value ?? '')
    return Object.values(o).map(propertyValue).filter(Boolean).join('\n')
  }
  return String(v)
}

/** Наименьший положительный `id` среди строк каталога, либо null. */
function minId(rows: Array<Record<string, unknown>>): number | null {
  const ids = rows.map(r => Number(r.id)).filter(n => Number.isInteger(n) && n > 0)
  return ids.length ? Math.min(...ids) : null
}

function positiveInt(v: unknown): number | null {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}
