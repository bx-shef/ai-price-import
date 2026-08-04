import { CONSENT_PATHS, CONSENT_VERSION } from '../config/cookieConsent'

// Чистое ядро решения о cookie (#404): что хранить, где показывать, когда спрашивать снова.
// Без DOM и без реактивности — всё это в composable и компоненте.

/** Ответ посетителя. `null` — не отвечал (или ответ нечитаем). */
export type ConsentChoice = 'accepted' | 'declined' | null

export interface ConsentRecord {
  choice: Exclude<ConsentChoice, null>
  version: number
}

/**
 * Разбор сохранённого решения.
 *
 * ⚠ Любое непонятное значение читается как «не отвечал», а не как согласие. Мусор в хранилище
 * (правка руками, чужой ключ, недописанная запись) не вправе включить счётчик — цена ошибки
 * несимметрична: лишний показ баннера это неудобство, аналитика без согласия — нарушение
 * собственного документа.
 */
export function parseConsent(raw: string | null | undefined): ConsentChoice {
  if (!raw) return null
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  const rec = data as Partial<ConsentRecord> | null
  if (!rec || typeof rec !== 'object') return null
  // Версия ниже текущей — вопрос с тех пор изменился по смыслу, значит прежний ответ на него не
  // отвечает. Версия ВЫШЕ (откат приложения) тоже спрашивается заново: чужой ответ мы не знаем.
  if (rec.version !== CONSENT_VERSION) return null
  return rec.choice === 'accepted' || rec.choice === 'declined' ? rec.choice : null
}

/** Строка для записи в хранилище. */
export function serializeConsent(choice: Exclude<ConsentChoice, null>): string {
  return JSON.stringify({ choice, version: CONSENT_VERSION } satisfies ConsentRecord)
}

/**
 * Показывать ли уведомление на этом адресе.
 *
 * Сравнение — по нормализованному пути (хвостовой слэш у Nuxt появляется и исчезает в зависимости
 * от того, пререндер это или переход внутри приложения; на такой мелочи баннер пропал бы ровно на
 * половине заходов).
 */
export function isConsentPath(path: string): boolean {
  const p = normalisePath(path)
  return (CONSENT_PATHS as readonly string[]).some(allowed => normalisePath(allowed) === p)
}

function normalisePath(path: string): string {
  // ⚠ Регистр приводится: vue-router по умолчанию матчит адрес нечувствительно к регистру, поэтому
  // `/EULA` из чужого письма отдаёт ту же страницу, а `route.path` остаётся `'/EULA'` — сравнение
  // «как есть» оставило бы такого посетителя без баннера на публичной странице.
  const clean = String(path ?? '').split('?')[0]!.split('#')[0]!.toLowerCase()
  if (clean.length > 1 && clean.endsWith('/')) return clean.slice(0, -1)
  return clean || '/'
}

/**
 * Один и тот же ли это адрес.
 *
 * ⚠ Нужен потому, что компонент сравнивал пути СВОИМ выражением, без снятия хвостового слэша —
 * ровно того, ради чего нормализатор и написан: на `/site-privacy/` ссылка «Политика сайта»
 * показывалась и вела туда, где посетитель уже стоит.
 */
export function samePath(a: string, b: string): boolean {
  return normalisePath(a) === normalisePath(b)
}

/** Запускать ли аналитику: только по явному согласию. */
export function analyticsAllowed(choice: ConsentChoice): boolean {
  return choice === 'accepted'
}
