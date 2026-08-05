// Per-portal configuration (mapping). Stored in app.option via server-side REST.
// Pure types — see docs/PROCESS.md §2 «Настройка».

/** CRM entity kinds the import can create.
 *  - lead (entityTypeId 1, #135): carries originId/originatorId (marker), so idempotent; the
 *    supplier nuance (found → companyId / not found → companyTitle) lives in crm-sync.
 *  - quote (КП, entityTypeId 7) is intentionally NOT a target — no filterable external-marker
 *    field, AND an incoming counterparty document has nothing to import into an outgoing offer
 *    (owner decision, #135). */
export type TargetEntityKind = 'lead' | 'deal' | 'smart-process' | 'invoice'

/** Bitrix24 entityTypeId helpers: deal=2, invoice(smart)=31, smart-process >= 1000.
 *  (quote=7 is not a target — see #135.) */
export interface TargetRef {
  entityTypeId: number
  /** Direction (voronka) — crm.category.* id. */
  categoryId?: number
  /** Stage id within the category. */
  stageId?: string
}

/** A routing rule: condition -> target. First matching rule wins. */
export interface RoutingRule {
  match: {
    /** Match on the classified document type (agent), case/locale-insensitive. */
    type?: string
    /** Match if any keyword occurs in the document text (deterministic). */
    keywords?: string[]
  }
  target: TargetRef
}

/** How the supplier-article field on a catalog product is shaped. */
export interface ArticleFieldConfig {
  /** Catalog property code holding the supplier article(s). */
  field: string
  /**
   * КАКОМУ инфоблоку принадлежит свойство: торговым предложениям или базовым товарам.
   *
   * ⚠ Свойство живёт ровно в одном из них, поэтому искать по нему нужно ОДИН раз и именно там.
   * Хранить это обязательно, а не угадывать: портал **молча игнорирует** фильтр по свойству,
   * которого в инфоблоке нет, и возвращает ВЕСЬ список (проверено вживую 2026-08-05 —
   * `%PROPERTY_999999` вернул все товары, свойство предложений на товарах — тоже все). Искать
   * «на всякий случай в обоих» значило бы в одном из них получить весь каталог и подобрать
   * произвольную позицию.
   * ⚠ `'product'` — значение по умолчанию для настроек, сохранённых до появления поля: прежний
   * пикер показывал только свойства основного каталога товаров.
   */
  scope?: 'product' | 'offer'
  /** 'text' → one article per line; 'string' → delimiter-separated. */
  kind: 'text' | 'string'
  /** Required when kind === 'string' — admin-chosen delimiter. */
  delimiter?: string
}

/** Product lookup strategy. */
export interface ProductLookupConfig {
  /** Единственная стратегия — по артикулу (свойство каталога → внешний код). Подбора по ИМЕНИ нет:
   *  решение владельца 2026-08-05, обоснование — в `server/utils/productLookup.findProduct`. Поле
   *  оставлено как `'article'`-литерал, чтобы сохранённые настройки порталов читались без миграции. */
  by: 'article'
  /** What to do when no product matched. Creating a catalog product was removed (too complex an
   *  operation for a multitenant import) — an unmatched line is either dropped with a warning
   *  (`skip-warn`) or written as a free-form position without a product id (`freeform`). */
  onMissing: 'skip-warn' | 'freeform'
}

/** Unit-of-measure mapping (see Q11). */
export interface UnitsConfig {
  /** Lower-cased document unit synonym -> catalog.measure code. */
  dictionary: Record<string, number>
  /** Default measure code when nothing matched. */
  defaultCode: number
  /** Auto-create a measure when missing (and report as an error). */
  autoCreate: boolean
}

/** Money side of the «Экономия» block (#270). Optional by design: without an admin-set rate the
 *  dashboard shows time only — the app is multitenant across BY/RU/KZ and there is no honest
 *  default hourly rate. The currency is NOT stored here: it is the portal's own base currency. */
export interface SavingsConfig {
  /** Operator cost per hour in the portal's base currency. Positive; 0/absent ⇒ no money figure. */
  ratePerHour: number
}

/** Full per-portal mapping. */
export interface PortalMapping {
  article: ArticleFieldConfig
  product: ProductLookupConfig
  units: UnitsConfig
  /** Whether to save the source file to Disk + attach to the activity. */
  saveFile: boolean
  /** Notification / error chat dialog ids. */
  notifyChatId?: string
  errorChatId?: string
  /** Ordered routing rules (first match wins). */
  routingRules: RoutingRule[]
  /** Fallback target when no rule matched (required). */
  defaultTarget: TargetRef
  /** Hourly rate for the money estimate. Absent ⇒ the dashboard shows time only (#270). */
  savings?: SavingsConfig
  /**
   * Админ хоть раз сохранял настройки. Ставится в `writeMapping` — единственной точке записи.
   *
   * До #373 факт настройки ВЫЧИСЛЯЛСЯ: `isPortalConfigured` сравнивала значения с дефолтами. Пока
   * дефолты не менялись, это работало; на первой же смене выяснилось, что признак ретроактивен —
   * значение, которое админ выбрал руками, стало равно новому дефолту и портал мгновенно
   * «расстроился». Для не-админа это не косметика: рабочий экран скрыт целиком, и он видит
   * «обратитесь к администратору» на портале, который импортирует нормально.
   *
   * Флаг снимает весь класс: сохранение — событие, а не значение, и от дефолтов не зависит. Старые
   * порталы, сохранявшиеся до появления флага, по-прежнему опознаются прежними эвристиками.
   */
  configured?: boolean
}
