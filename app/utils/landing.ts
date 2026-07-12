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

export const LANDING_CTA = 'Открыть приложение'
export const LANDING_PUBLISHER = 'Издатель: ИП Шевчик И.С.'

/** Bitrix24 Marketplace listing of this app (owner-provided slug `shef.priceimport`). */
export const LANDING_MARKET_URL = 'https://www.bitrix24.ru/apps/app/shef.priceimport/'

/** Copyright year range string: "2026" or "2024–2026". */
export function copyrightYears(from: number, current: number): string {
  return from >= current ? String(current) : `${from}–${current}`
}
