import type { RestCall } from './b24Rest'
import type { PortalMapping, ArticleFieldConfig } from '~/types/mapping'
import type { DocumentItem } from '~/types/document'
import { findCatalogByProperty, findCatalogByXmlId, NO_IBLOCKS, OFFER_SOURCE, PRODUCT_SOURCE, type CatalogIblocks, type CatalogSource } from './catalogLookup'

export type { CatalogIblocks }

// Deterministic product lookup for crm-sync. DI over RestCall; the mechanics live in
// `catalogLookup.ts` — this file is the ORDER of strategies and nothing else.
//
// ⚠ Читается ТОЛЬКО артикул. По названию не ищем никогда — `tests/noNameLookup.test.ts`.
//
// ⚠ Методы `crm.product.*` DEPRECATED (в справочнике так и написано) — весь путь переведён на
// `catalog.product.list` / `catalog.product.offer.list`. Практическая разница не только в имени:
// у `catalog.*` `iblockId` ОБЯЗАТЕЛЕН в фильтре, поэтому подбор больше не может работать «вообще
// по каталогу» и получает инфоблоки явно. Резолв — один раз на задание (`liveDeps`).
//
// Только активные записи (`active: 'Y'`) — решение владельца: архивный товар не должен попадать в
// документ клиента. LIVE-VERIFIED 06.08.2026 (`pnpm verify:article`, #383): вся матрица краевых
// случаев гоняет ИМЕННО эту функцию, а не переписанный в скрипте запрос — неактивный товар с
// подходящим артикулом не подбирается; `ZQ-5` не подбирает `ZQ-50`; обе формы поля разбираются;
// внешний код работает без настроенного свойства; несуществующее свойство даёт «не найдено», а не
// первый товар каталога. Два ограничения подтверждены КАК ограничения: артикул, отличающийся
// омоглифом (кир. `С` против лат. `C`), не находится вовсе (сравнение на портале побайтовое, наша
// свёртка помогает лишь среди уже возвращённых строк), и артикул-подстрока у >50 записей может не
// найтись — читается одна страница ответа.

/** Найти активный товар базового каталога по внешнему коду (`xmlId`), либо null. */
export async function findProductByXmlId(code: string, iblockId: number | null, call: RestCall): Promise<number | null> {
  if (!iblockId) return null
  const hit = await findCatalogByXmlId(PRODUCT_SOURCE, code, iblockId, call)
  return hit.kind === 'found' ? hit.id : null
}

/** Найти активный товар базового каталога по свойству с артикулом поставщика, либо null. */
export async function findProductByArticle(article: string, cfg: ArticleFieldConfig, iblockId: number | null, call: RestCall): Promise<number | null> {
  return iblockId ? await findCatalogByProperty(PRODUCT_SOURCE, article, cfg, iblockId, call) : null
}

/**
 * Перебрать инфоблоки ОДНОГО вида по ВНЕШНЕМУ КОДУ — до первого попадания либо до отказа.
 *
 * ⚠ Решение владельца 06.08.2026: перебирать каждый каталог. Прежде брался ПЕРВЫЙ, и на портале с
 * несколькими товарными каталогами позиция из второго не находилась никогда — исход неотличим от
 * «товара нет»: строка уезжает свободной, сумма сходится, статус «Готово».
 *
 * ⚠ НЕОДНОЗНАЧНОСТЬ ПРЕКРАЩАЕТ ПОДБОР ЦЕЛИКОМ, а не только текущую итерацию. Разбор поймал этот
 * дефект в первой редакции: отказ по неоднозначности был неотличим от «не нашли», и перебор шёл
 * дальше — каталог A с парой `ZQ-1`/`zq-1` давал отказ, а каталог B подсовывал ПОСТОРОННИЙ товар.
 * То есть гард против подмены товара сам приводил к подмене, только из другого каталога.
 *
 * ⚠ Плата за перебор невелика: до N запросов на НЕнайденную позицию при N каталогах, а у
 * подавляющего большинства порталов каталог один. Перебор идёт только пока не нашли.
 */
async function firstXmlIdMatch(src: CatalogSource, article: string, iblockIds: readonly number[], call: RestCall): Promise<number | null | 'stop'> {
  for (const iblockId of iblockIds) {
    const hit = await findCatalogByXmlId(src, article, iblockId, call)
    if (hit.kind === 'found') return hit.id
    if (hit.kind === 'ambiguous') return 'stop'
  }
  return null
}

/** Перебрать инфоблоки одного вида по СВОЙСТВУ артикула — до первого попадания. */
async function firstPropertyMatch(src: CatalogSource, article: string, cfg: ArticleFieldConfig, iblockIds: readonly number[], call: RestCall): Promise<number | null> {
  for (const iblockId of iblockIds) {
    const hit = await findCatalogByProperty(src, article, cfg, iblockId, call)
    if (hit) return hit
  }
  return null
}

/**
 * Подобрать товар каталога по строке документа. ТОЛЬКО по артикулу.
 *
 * Порядок — от самого сильного признака к настраиваемому (решение владельца 2026-08-05):
 *   1. **внешний код торгового предложения** (`xmlId`) — напечатанный артикул чаще всего именно он;
 *   2. **внешний код базового товара** — системное поле, настройки не требует;
 *   3. **свойство с артикулом поставщика** — в инфоблоках ТОГО ВИДА, который выбран настройкой.
 *
 * ⚠ Каждый шаг перебирает ВСЕ инфоблоки своего вида до первого попадания (решение владельца
 * 06.08.2026): портал с несколькими товарными каталогами иначе искал бы только в первом.
 *
 * ⚠ Вид свойства (`article.scope`) при этом по-прежнему берётся ИЗ НАСТРОЙКИ, а не перебирается.
 * Свойство живёт ровно в одном виде инфоблоков — предложений либо товаров, — а портал **молча
 * игнорирует** фильтр по свойству, которого в инфоблоке нет, и возвращает ВЕСЬ список (живая
 * проверка 2026-08-05). «Поискать на всякий случай в обоих видах» дало бы в одном из них весь
 * каталог. Перебор ВНУТРИ вида безопасен по той же причине, по которой вообще работает подбор:
 * точное совпадение артикула сверяется на клиенте, и чужой каталог отсеивается целиком.
 *
 * ⚠ Оба внешних кода идут ДО свойства намеренно: они не зависят от настройки, поэтому портал,
 * где админ ничего не выбрал, всё равно подбирает товар.
 */
export async function findProduct(item: DocumentItem, mapping: PortalMapping, call: RestCall, iblocks: CatalogIblocks = NO_IBLOCKS): Promise<number | null> {
  const article = (item.article ?? '').trim()
  if (!article) return null

  // 1) Внешний код торгового предложения — во всех каталогах предложений.
  const byOfferXml = await firstXmlIdMatch(OFFER_SOURCE, article, iblocks.offer, call)
  if (byOfferXml === 'stop') return null
  if (byOfferXml) return byOfferXml

  // 2) Внешний код базового товара — во всех товарных каталогах.
  const byXmlId = await firstXmlIdMatch(PRODUCT_SOURCE, article, iblocks.product, call)
  if (byXmlId === 'stop') return null
  if (byXmlId) return byXmlId

  // 3) Свойство — в инфоблоках ТОГО вида, который выбран настройкой.
  // ⚠ Вид (`scope`) по-прежнему решает настройка: свойство живёт ровно в одном инфоблоке, а портал
  // МОЛЧА игнорирует фильтр по чужому свойству и отдаёт весь список. Перебор внутри вида безопасен
  // ровно потому, что точное совпадение артикула сверяется на клиенте — иначе первый же каталог без
  // такого свойства вернул бы весь свой список и подсунул произвольную позицию.
  if (mapping.article.field) {
    const scope = mapping.article.scope === 'offer' ? 'offer' : 'product'
    const src = scope === 'offer' ? OFFER_SOURCE : PRODUCT_SOURCE
    return await firstPropertyMatch(src, article, mapping.article, iblocks[scope], call)
  }
  return null
}
