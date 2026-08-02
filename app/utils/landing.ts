// Landing content + pure helpers (single source of truth, testable). Marketing
// copy is Russian; see docs/PROCESS.md.

import { PUBLISHER } from '../config/publisher'

export const LANDING_TITLE = 'AI-импорт прайсов в Bitrix24'
export const LANDING_SUBTITLE
  = 'Накладные, счета, КП и прайсы разбираются автоматически: товары и контрагент подбираются по вашей базе, а на выходе — готовый лид, сделка, счёт или смарт-процесс с позициями, суммами и НДС 1-в-1.'

export interface LandingStep { n: number, title: string, text: string }
export const LANDING_STEPS: LandingStep[] = [
  { n: 1, title: 'Загрузите документ', text: 'Прямо в портале — PDF, скан, фото, Excel, Word или CSV. Одним файлом или пачкой.' },
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
/** Rights holder shown on the landing (SEO author/og:site_name). Source — `app/config/publisher.ts` (#297). */
export const LANDING_PUBLISHER = PUBLISHER.shortName

/**
 * SEO/OG description — its OWN string, no longer an alias of the subtitle (#329).
 * Share-card validators want 90–155 characters: below that it reads as too short, above it gets
 * truncated mid-sentence. The hero subtitle is written for the page (195 chars, and fine there);
 * as a description it was cut. Length is pinned by a test — a copy edit must not silently break it.
 */
export const LANDING_DESCRIPTION
  = 'AI-импорт накладных, счетов, КП и прайсов в Bitrix24: контрагент и товары подбираются по вашей базе, суммы и НДС — 1-в-1.'

/** The window share-card validators check `description` against. */
export const DESCRIPTION_MIN = 90
export const DESCRIPTION_MAX = 155

/** Small reassurance note under the hero CTAs. */
export const LANDING_HERO_NOTE = 'Бесплатное приложение закрывает импорт. Настройку под ваш процесс берём на себя.'

/** «Tech-string» под hero — какие ФАЙЛЫ понимает разбор. */
export const LANDING_FORMATS: string[] = [
  'PDF', 'Скан / фото (OCR)', 'Excel', 'Word', 'CSV'
]

/** Виды документов — отдельной строкой: у них своя ось (что за бумага, а не чем открывается),
 *  и вперемешку с расширениями они читались как один список. */
export const LANDING_DOC_KINDS: string[] = [
  'Накладная', 'Счёт', 'КП', 'Прайс'
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
  /** Подпись бейджа рядом со словом «Bitrix24» — тем же знаком, что «Партнёр» в hero. */
  badgeCaption: 'Приложение',
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

/** Absolute site base (scheme + host + port) for canonical/OG/robots/sitemap: the configured
 *  deployment URL when it is a usable absolute http(s) address (a staging or Vibecode host must
 *  advertise itself), else the canonical landing home.
 *
 *  PARSED, not pattern-matched. A prefix regex (`^https?://…`) constrains only the first bytes, and
 *  the value it lets through is then interpolated into a LINE-oriented file (robots.txt) and into
 *  MARKUP (sitemap `<loc>`) — so `https://host\nAllow: /` injected robots directives and
 *  `https://host@evil.test` silently pointed canonical/og:image at another domain. `new URL` rejects
 *  both, and `.origin` normalises scheme/host case and drops path, query and fragment (a base with a
 *  query made og:image resolve to the HTML page, not the picture). Same bar as `isSafeB24Domain`.
 *
 *  NB: a deployment served under a sub-path is not supported — `.origin` drops it. We serve at the
 *  root on every target (nginx `location /`, Vibecode single process). */
export function siteBaseUrl(siteUrl?: string | null): string {
  const raw = (siteUrl ?? '').trim()
  if (!raw) return LANDING_SITE_URL
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return LANDING_SITE_URL // relative, protocol-relative, whitespace/newline, garbage
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return LANDING_SITE_URL
  if (!u.hostname || u.username || u.password) return LANDING_SITE_URL // userinfo confusion
  return u.origin
}

/**
 * CTA лендинга для промо-баннера внутри портала (#231): всегда АБСОЛЮТНЫЙ адрес брифа.
 *
 * Раньше баннер склеивал ссылку из сырого `NUXT_PUBLIC_SITE_URL`, и при пустом или неабсолютном
 * значении получался ОТНОСИТЕЛЬНЫЙ путь. Внутри портального iframe он резолвится к домену КЛИЕНТА —
 * кнопка «Обсудить» уводила на `https://<клиент>.bitrix24.by/?…#brief` вместо лендинга, и никакой
 * ошибки при этом не возникало. Тот же капкан, что с canonical/og (#304), поэтому и правило то же:
 * дом ровно один, отсутствующий env падает на него, а не деградирует в относительный путь.
 *
 * UTM стоит ДО якоря — за `#` он уехал бы в хеш и до аналитики не долетел.
 */
export function appBriefUrl(siteUrl?: string | null): string {
  return `${siteBaseUrl(siteUrl)}/?utm_source=b24app&utm_medium=app_promo#brief`
}

/** Absolute URL of the OG share image for scrapers. Always absolute — see `siteBaseUrl`. */
export function ogImageUrl(siteUrl?: string | null): string {
  return `${siteBaseUrl(siteUrl)}/og.png`
}

/** Absolute canonical URL of a ROOT-RELATIVE page path (`'/'` → the site root, no trailing-slash
 *  duplication). An absolute URL passed as `path` would otherwise be appended to the base
 *  (`…/https://evil.tld/x`), so anything with a scheme falls back to the root. */
export function canonicalUrl(path: string, siteUrl?: string | null): string {
  const base = siteBaseUrl(siteUrl)
  const p = typeof path === 'string' ? path.trim() : ''
  if (!p || p === '/' || /^[a-z][a-z0-9+.-]*:/i.test(p)) return `${base}/`
  return `${base}/${p.replace(/^\/+/, '')}`
}

/**
 * Is this deployment THE canonical landing host? (#304)
 *
 * There is exactly one public home of the landing — `LANDING_SITE_URL`. Every other deployment that
 * serves the same pages (staging, a Vibecode target, a client's isolated server) is a DUPLICATE by
 * construction, and a duplicate must not advertise itself to search engines: its canonical tag has
 * to point at production, and its sitemap must not invite crawlers in. Comparison is on the
 * VALIDATED origin (`siteBaseUrl`), so an unset/garbage env — which falls back to the canonical
 * home anyway — counts as canonical rather than flapping on formatting.
 */
export function isCanonicalHost(siteUrl?: string | null): boolean {
  return siteBaseUrl(siteUrl) === LANDING_SITE_URL
}

/** Copyright year range string: "2026" or "2024–2026". */
export function copyrightYears(from: number, current: number): string {
  return from >= current ? String(current) : `${from}–${current}`
}
