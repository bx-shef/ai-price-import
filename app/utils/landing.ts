// Landing content + pure helpers (single source of truth, testable). Marketing
// copy is Russian; see docs/PROCESS.md.

export const LANDING_TITLE = 'AI-импорт прайсов в Bitrix24'
export const LANDING_SUBTITLE
  = 'Накладные, счета, КП и прайсы превращаются в товары в вашей CRM: контрагент находится сам, суммы и НДС сходятся 1-в-1.'

export interface LandingStep { n: number, title: string, text: string }
export const LANDING_STEPS: LandingStep[] = [
  { n: 1, title: 'Загрузите документ', text: 'Прямо в портале — PDF, скан, фото, Excel или Word. Одним файлом или пачкой.' },
  { n: 2, title: 'AI разбирает', text: 'Распознаёт контрагента (ИНН/УНП/БИН), позиции, единицы и НДС — на русском, белорусском или казахском.' },
  { n: 3, title: 'Товары в CRM', text: 'Создаётся целевая сущность (сделка / лид / счёт / смарт-процесс) с товарными позициями — 1-в-1 с документом.' }
]

export interface LandingFeature { title: string, text: string }
export const LANDING_FEATURES: LandingFeature[] = [
  { title: '1-в-1 со счётом', text: 'Суммы, количества и НДС переносятся точно — без потери строк и без ручной сверки.' },
  { title: 'Любой формат', text: 'Цифровой PDF, скан и фото (OCR), таблицы и документы — распознаётся всё.' },
  { title: 'Мультиязычность', text: 'Документы на русском, белорусском и казахском — метки налоговых ID на языке документа.' },
  { title: 'Ваши правила', text: 'Маппинг под ваш портал: целевая сущность, поле артикула, стратегия товара, единицы.' }
]

// Primary hero CTA leads to the individual-integration brief; the app is installed
// FROM the Marketplace, so the app button opens the listing (not /app).
export const LANDING_CTA_BRIEF = 'Обсудить интеграцию'
export const LANDING_CTA_MARKET = 'Открыть в Маркете Bitrix24'
export const LANDING_PUBLISHER = 'ИП Шевчик И.С.'

/** Alias of the subtitle for SEO/OG description (single source). */
export const LANDING_DESCRIPTION = LANDING_SUBTITLE

/** Small reassurance note under the hero CTAs. */
export const LANDING_HERO_NOTE = 'Бесплатное приложение закрывает импорт. Настройку под ваш процесс берём на себя.'

/** «Tech-string» под hero — какие форматы документов понимает разбор. */
export const LANDING_FORMATS: string[] = [
  'PDF', 'Скан / фото (OCR)', 'Excel', 'Word', '1С', 'Накладная · Счёт · КП · Прайс'
]

/** Боль → результат (секция под hero). */
export const LANDING_PAIN_RESULT = {
  before: 'Позиции из счёта или накладной вбивают в CRM руками — по строке за раз. Ошибки в суммах и НДС, потерянные строки, часы на сверку.',
  after: 'Загрузили документ — AI распознал контрагента и все позиции и создал сделку/счёт с товарами 1-в-1. Сверять нечего.'
} as const

/** Подзаголовки секций (левый блок «h2 + описание», как в client-bank). */
export const LANDING_HOW_SUBTITLE = 'Три шага — от документа до товаров в вашей CRM.'
export const LANDING_WHY_SUBTITLE = 'Бесплатное приложение закрывает импорт. Установку в ваш контур и настройку под процессы берём на себя.'

/** Промо-карточка «Приложение в Маркете» (бесплатная точка входа, self-install). */
export const LANDING_MARKET_PROMO = {
  eyebrow: 'Приложение для Bitrix24',
  title: 'AI-импорт прайсов прямо в Bitrix24',
  text: 'Само приложение — бесплатное, есть в Маркете Bitrix24. Установите за минуту и загружайте документы прямо в портале.',
  cta: 'Открыть в Маркете Bitrix24'
} as const

/** Текст блока для интеграторов/партнёров. */
export const LANDING_INTEGRATORS
  = 'Внедряете Bitrix24 клиентам? Подключим AI-импорт прайсов под их процессы — свои поля, сущности и источники — и развернём в вашем контуре.'

/** Индивидуальная доработка: автоматический сбор прайсов из внешних источников (на сервере клиента —
 *  облачное приложение Маркета этого не делает, это платная интеграция под ваш контур). */
export const LANDING_SOURCES = {
  title: 'Прайс приходит сам — из вашего источника',
  text: 'Не хотите загружать файлы вручную? Забираем прайсы автоматически — из почты, Telegram, по FTP или из другого источника. Это индивидуальная доработка на вашем сервере.'
} as const

/** Bitrix24 Market listing code (slug) of this app — the single source of truth also used to build
 *  the in-portal «оцените приложение» openPath and the public listing URL below. */
export const LANDING_MARKET_CODE = 'shef.priceimport'

/** Bitrix24 Marketplace listing of this app (public витрина URL). */
export const LANDING_MARKET_URL = `https://www.bitrix24.ru/apps/app/${LANDING_MARKET_CODE}/`

/** Canonical public home of the LANDING. A constant, not env: the landing has exactly one public
 *  address, and the share/canonical tags must be absolute even when `NUXT_PUBLIC_SITE_URL` was not
 *  baked into the build. That env var stays the source of truth for the *deployment* URL (install
 *  handler, Vibecode target) — it just isn't allowed to decide whether og:image works at all. */
export const LANDING_SITE_URL = 'https://price-import.bx-shef.by'

/** Absolute site base for canonical/OG tags: the configured deployment URL when known (a staging or
 *  Vibecode host must advertise itself), else the canonical landing home. Trailing slashes trimmed;
 *  a value without a scheme is rejected (a relative base would produce a relative og:image, which
 *  Facebook/LinkedIn drop — the whole defect this guards against). */
export function siteBaseUrl(siteUrl?: string | null): string {
  const raw = (siteUrl ?? '').trim().replace(/\/+$/, '')
  return /^https?:\/\/[^/]/i.test(raw) ? raw : LANDING_SITE_URL
}

/** Absolute URL of the OG share image for scrapers. Always absolute — see `siteBaseUrl`. */
export function ogImageUrl(siteUrl?: string | null): string {
  return `${siteBaseUrl(siteUrl)}/og.png`
}

/** Absolute canonical URL of a page path (`'/'` → the site root, no trailing-slash duplication). */
export function canonicalUrl(path: string, siteUrl?: string | null): string {
  const base = siteBaseUrl(siteUrl)
  const p = (path ?? '/').trim()
  if (!p || p === '/') return `${base}/`
  return `${base}/${p.replace(/^\/+/, '')}`
}

/** Copyright year range string: "2026" or "2024–2026". */
export function copyrightYears(from: number, current: number): string {
  return from >= current ? String(current) : `${from}–${current}`
}
