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
 * Инфоблоки каталога — ВСЕ, а не первый: списки предложений и товаров в порядке ответа портала.
 *
 * ⚠ Раньше отсюда возвращалась ОДНА пара, и это было тихим ограничением: на портале с несколькими
 * товарными каталогами подбор ходил только в первый, а товар из второго не находился НИКОГДА —
 * строка молча уезжала свободной позицией. Решение владельца 06.08.2026: перебирать каждый каталог
 * до первого найденного.
 *
 * ⚠ Живёт здесь, а не в модуле пикера настроек: инфоблок нужен КАЖДОМУ запросу подбора (методы
 * `catalog.*` требуют `iblockId` в фильтре), то есть это часть ядра подбора. Пикер импортирует отсюда.
 */
export async function resolveIblocks(call: RestCall): Promise<CatalogIblocks> {
  // The transport's `.call` (makeSdkRestCall) returns the UNWRAPPED `result`, so read
  // `catalogs` directly — NOT `result.catalogs` (that double-unwrap yields undefined in prod).
  // ⚠ Форм ответа обрабатываем ДВЕ: `{ catalogs: [...] }` и голый массив. На портале наблюдалась
  // только первая; вторая — страховка транспорта, покрытая тестом, а не живое наблюдение.
  const resp = await call('catalog.catalog.list', {}) as { catalogs?: Array<Record<string, unknown>> } | Array<Record<string, unknown>> | undefined
  const catalogs = (Array.isArray(resp) ? resp : resp?.catalogs) ?? []
  const offer: number[] = []
  const product: number[] = []
  for (const c of catalogs) {
    // ⚠ `positiveInt` на каждом по отдельности, а не `??` над сырыми: `iblockId: 0` или пустая
    // строка — не `null`, и фолбэк на `id` не сработал бы.
    const own = positiveInt(c.iblockId) ?? positiveInt(c.id)
    const parent = positiveInt(c.productIblockId)
    // Каталог предложений — тот, что УКАЗЫВАЕТ на родительский инфоблок товаров. Его родитель это
    // товарный инфоблок, и он попадает в список товаров ДАЖЕ если сам отдельной строкой не пришёл.
    if (parent) {
      if (own) push(offer, own)
      push(product, parent)
    } else if (own) {
      push(product, own)
    }
  }
  return { offer, product }
}

/** Инфоблоки каталога по видам. Порядок — как ответил портал; перебор идёт по нему.
 *  ⚠ Списки `readonly`: их только читают, а пустой набор `NO_IBLOCKS` — общий замороженный
 *  синглгон, и мутируемый тип позволил бы дописать в него id «на месте». */
export interface CatalogIblocks {
  offer: readonly number[]
  product: readonly number[]
}

/**
 * Пустой набор — портал без каталога (или каталог не прочитан). Подбора не будет, но и падения тоже.
 *
 * ⚠ ЗАМОРОЖЕН: это экспортируемый синглтон, стоящий значением параметра по умолчанию. Незамороженные
 * массивы однажды протекли бы между заданиями — достаточно правки, которая допишет в них id.
 */
export const NO_IBLOCKS: CatalogIblocks = Object.freeze({ offer: Object.freeze([] as number[]), product: Object.freeze([] as number[]) })

/** Исход подбора по внешнему коду. `ambiguous` — НЕ синоним «не нашли»: см. `findCatalogByXmlId`. */
export type XmlIdMatch = { kind: 'found', id: number } | { kind: 'none' } | { kind: 'ambiguous' }

/** Добавить id, не задваивая: товарный инфоблок приходит и сам по себе, и как родитель предложений. */
function push(list: number[], id: number): void {
  if (!list.includes(id)) list.push(id)
}

/**
 * Найти активную запись каталога по ВНЕШНЕМУ КОДУ (`xmlId`), либо null.
 *
 * ⚠ РЕГИСТР СРАВНИВАЕТ БАЗА, А НЕ МЫ И НЕ API. Проверено вживую 06.08.2026 и подтверждено разбором
 * ядра (владелец): `xmlId` разбирается как фильтр типа `string`, и MySQL-ветка `CIBlock::FilterCreateEx`
 * строит голое `LIKE 'значение'` без `UPPER()` — сравнение целиком отдано СУБД, то есть коллации
 * колонки. Битрикс ставится с регистронезависимой коллацией, поэтому облако находит `zq-x` по
 * `ZQ-X`; коробка на двоичной коллации сравнивала бы с учётом регистра. Префикс `=` режим НЕ
 * переключает (живая проба вернула обе строки); прочие префиксы не проверялись.
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
 * облака И для коробки. Решение НИЧЕГО НЕ ОТНИМАЕТ ни у одной установки, и записать это надо точно:
 * первая редакция комментария называла «плату», которой нет, и читалась так, будто выбор что-то
 * сломал на коробках.
 *   • Облако (коллация без учёта регистра): `zq-1` подбирает `ZQ-1` — работало и работает.
 *   • Коробка с двоичной коллацией: такой документ не подберётся, но НЕ из-за решения — портал
 *     просто не возвращает строку, сравнение произошло в базе ДО нашего кода. Так было и до, и после.
 *     Починить это на нашей стороне нельзя в принципе: сворачивать нечего, ответ пуст.
 * Отвергнутая альтернатива (строгая сверка `===` у нас) коробку бы НЕ вылечила — она уравняла бы
 * установки ВНИЗ, сломав облако до уровня коробки: поставщик печатает `zq-1`, в каталоге `ZQ-1`,
 * сегодня совпадение есть, а стало бы нечем. Цена была у отвергнутого варианта, не у выбранного.
 * Поэтому не переписывать «для единообразия».
 * ⚠ Случай к тому же редкий: Битрикс ставится с регистронезависимой коллацией, двоичная возникает
 * лишь при нестандартном восстановлении базы.
 */
export async function findCatalogByXmlId(src: CatalogSource, xmlId: string, iblockId: number, call: RestCall): Promise<XmlIdMatch> {
  const q = (xmlId ?? '').trim()
  if (!q || !iblockId) return { kind: 'none' }
  const rows = await listRows(src, { iblockId, xmlId: q, active: 'Y' }, ['id', 'iblockId', 'xmlId'], call)
  // ⚠ СВЕРКА НА КЛИЕНТЕ ОБЯЗАТЕЛЬНА и здесь, а не только у свойства. Две причины, обе живые:
  // (1) портал уже был замечен на том, что МОЛЧА игнорирует непонятный ему фильтр и возвращает
  //     весь список (05.08.2026, свойства). Полное доверие фильтру однажды подставит клиенту
  //     первую строку каталога — а строки без `xmlId` вообще выпадали из проверки написаний;
  // (2) значение уходит в `LIKE`, где `%` и `_` — джокеры. Артикул «ZQ_1» совпал бы расширенно,
  //     причём написание в ответе одно ⇒ проверка неоднозначности молчала бы.
  // Сравниваем регистронезависимо — ровно та терпимость, которую оставил владелец.
  const fold = (v: unknown) => String(v ?? '').trim().toLowerCase()
  const target = fold(q)
  const exact = rows.filter(r => fold(r.xmlId) === target)
  if (!exact.length) return { kind: 'none' }
  // Разные написания одного кода ⇒ выбор был бы произвольным. Не выбираем — и отвечаем ОТДЕЛЬНЫМ
  // исходом: «не нашли» и «отказались выбирать» это разные вещи, и вызывающий обязан их различать.
  const spellings = new Set(exact.map(r => String(r.xmlId ?? '')))
  if (spellings.size > 1) return { kind: 'ambiguous' }
  const id = minId(exact)
  return id ? { kind: 'found', id } : { kind: 'none' }
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
