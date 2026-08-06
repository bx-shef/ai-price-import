import type { RestCall } from './b24Rest'
import type { PortalMapping, ArticleFieldConfig } from '~/types/mapping'
import type { DocumentItem } from '~/types/document'
import { findCatalogByProperty, findCatalogByXmlId, OFFER_SOURCE, PRODUCT_SOURCE } from './catalogLookup'

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

/** Инфоблоки каталога, резолвятся раз на задание. `null` — такого каталога на портале нет. */
export interface CatalogIblocks {
  offer: number | null
  product: number | null
}

/** Найти активный товар базового каталога по внешнему коду (`xmlId`), либо null. */
export async function findProductByXmlId(code: string, iblockId: number | null, call: RestCall): Promise<number | null> {
  return iblockId ? await findCatalogByXmlId(PRODUCT_SOURCE, code, iblockId, call) : null
}

/** Найти активный товар базового каталога по свойству с артикулом поставщика, либо null. */
export async function findProductByArticle(article: string, cfg: ArticleFieldConfig, iblockId: number | null, call: RestCall): Promise<number | null> {
  return iblockId ? await findCatalogByProperty(PRODUCT_SOURCE, article, cfg, iblockId, call) : null
}

/**
 * Подобрать товар каталога по строке документа. ТОЛЬКО по артикулу.
 *
 * Порядок — от самого сильного признака к настраиваемому (решение владельца 2026-08-05):
 *   1. **внешний код торгового предложения** (`xmlId`) — напечатанный артикул чаще всего именно он;
 *   2. **внешний код базового товара** — системное поле, настройки не требует;
 *   3. **свойство с артикулом поставщика** — ОДИН раз, в том инфоблоке, которому оно принадлежит.
 *
 * ⚠ Почему свойство ищется один раз и строго по `article.scope`. Свойство живёт ровно в одном
 * инфоблоке — предложений либо товаров. Портал при этом **молча игнорирует** фильтр по свойству,
 * которого в инфоблоке нет, и возвращает ВЕСЬ список (живая проверка 2026-08-05). Значит «поискать
 * на всякий случай в обоих» дало бы в одном из них весь каталог; спасает только сверка точного
 * совпадения на клиенте, которая есть у обоих путей — но полагаться на неё как на единственную
 * защиту не нужно, когда инфоблок известен из настройки.
 *
 * ⚠ Оба внешних кода идут ДО свойства намеренно: они не зависят от настройки, поэтому портал,
 * где админ ничего не выбрал, всё равно подбирает товар.
 */
export async function findProduct(item: DocumentItem, mapping: PortalMapping, call: RestCall, iblocks: CatalogIblocks = { offer: null, product: null }): Promise<number | null> {
  const article = (item.article ?? '').trim()
  if (!article) return null

  // 1) Внешний код торгового предложения.
  if (iblocks.offer) {
    const byOfferXml = await findCatalogByXmlId(OFFER_SOURCE, article, iblocks.offer, call)
    if (byOfferXml) return byOfferXml
  }
  // 2) Внешний код базового товара.
  const byXmlId = await findProductByXmlId(article, iblocks.product, call)
  if (byXmlId) return byXmlId

  // 3) Свойство — один раз, в своём инфоблоке.
  if (mapping.article.field) {
    const scope = mapping.article.scope === 'offer' ? 'offer' : 'product'
    const src = scope === 'offer' ? OFFER_SOURCE : PRODUCT_SOURCE
    const iblockId = iblocks[scope]
    return iblockId ? await findCatalogByProperty(src, article, mapping.article, iblockId, call) : null
  }
  return null
}
