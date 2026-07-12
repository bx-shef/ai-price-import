// Landing content + pure helpers (single source of truth, testable). Marketing
// copy is Russian; see docs/redesign/04-marketing-landing.md.

export const LANDING_TITLE = 'AI-импорт документов в Bitrix24'
export const LANDING_SUBTITLE
  = 'Накладные, счета, КП и прайсы превращаются в товары в вашей CRM: контрагент находится сам, суммы и НДС сходятся 1-в-1.'

export interface LandingStep { n: number, title: string, text: string }
export const LANDING_STEPS: LandingStep[] = [
  { n: 1, title: 'Загрузите документ', text: 'Прямо в портале — PDF, скан, фото, Excel или Word. Одним файлом или пачкой.' },
  { n: 2, title: 'AI разбирает', text: 'Распознаёт контрагента (ИНН/УНП/БИН), позиции, единицы и НДС — на русском, белорусском или казахском.' },
  { n: 3, title: 'Товары в CRM', text: 'Создаётся целевая сущность (сделка / счёт / КП / смарт-процесс) с товарными позициями — 1-в-1 с документом.' }
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
  after: 'Загрузили документ — AI распознал контрагента и все позиции и создал сделку/счёт/КП с товарами 1-в-1. Сверять нечего.'
} as const

/** Текст блока для интеграторов/партнёров. */
export const LANDING_INTEGRATORS
  = 'Внедряете Bitrix24 клиентам? Подключим AI-импорт документов под их процессы — свои поля, сущности и источники — и развернём в вашем контуре.'

/** Bitrix24 Marketplace listing of this app (owner-provided slug `shef.priceimport`). */
export const LANDING_MARKET_URL = 'https://www.bitrix24.ru/apps/app/shef.priceimport/'

/**
 * Absolute URL of the OG share image for scrapers. `siteUrl` is set via
 * NUXT_PUBLIC_SITE_URL in prod; empty in dev → a relative `/og.png` (fine locally).
 */
export function ogImageUrl(siteUrl: string): string {
  const base = siteUrl.replace(/\/+$/, '')
  return `${base}/og.png`
}

/** Copyright year range string: "2026" or "2024–2026". */
export function copyrightYears(from: number, current: number): string {
  return from >= current ? String(current) : `${from}–${current}`
}
