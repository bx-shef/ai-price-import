// Разбор ТЕЛА нашего дела обратно в данные для журнала (#495).
//
// ЗАЧЕМ. Журнал строился из четырёх полей дела и показывал только заголовок, дату и «закрыто ли», а
// «результат» на соседнем экране брался из статуса задания — двух разных источников, которые не
// могли совпадать по построению. Решение владельца 10.08.2026: **брать из дела**, а дело обязано
// хранить ровно то, что нужно показать.
//
// ⚠ Разбирать чужой текст было бы гаданием, но тело пишем МЫ САМИ (`buildActivityBody`), подписанными
// блоками и в известном порядке. Поэтому это не эвристика: обе стороны — наш код, и они обязаны
// меняться вместе. Гард — тест, который прогоняет разбор по РЕАЛЬНОМУ выводу билдера, а не по
// выдуманной строке: иначе правка билдера тихо ломала бы журнал.
//
// ⚠ Ничего «умного» не угадываем: не нашли блок — поля просто нет. Домысленное число в журнале
// хуже отсутствующего, потому что его читают как факт о своём документе.

/** Что удалось вычитать из тела дела. Любое поле может отсутствовать — дело могли править руками. */
export interface ActivitySummary {
  supplier?: string
  /** Сколько позиций записано. */
  rows?: number
  /** Сколько из них сопоставлено с каталогом (может отсутствовать). */
  matched?: number
  /** Сумма — СТРОКОЙ, как её напечатал импорт: там уже валюта и формат. */
  amount?: string
  /** Сколько проблем перечислено в деле. */
  problems?: number
  /** Относительный путь карточки, созданной импортом. */
  entityPath?: string
  /** Подпись ссылки на карточку («Открыть сделку»). */
  entityLabel?: string
}

/** Снять BB-ссылку, оставив видимый текст: `[URL=/x]ООО «Ромашка»[/URL]` → `ООО «Ромашка»`. */
function stripUrl(value: string): string {
  return value.replace(/\[URL=[^\]]*\](.*?)\[\/URL\]/gi, '$1').trim()
}

function intOrUndefined(value: string | undefined): number | undefined {
  if (value == null) return undefined
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 ? n : undefined
}

/**
 * Parse the activity body written by `buildActivityBody` back into displayable fields.
 *
 * ⚠ Регистронезависимо и без привязки к номеру строки: порядок блоков — свойство билдера, а не
 * гарантия. Дело мог отредактировать человек в портале, и разбор обязан пережить перестановку и
 * дописанный сверху комментарий, а не рассыпаться.
 */
export function parseActivityBody(description: unknown): ActivitySummary {
  if (typeof description !== 'string' || !description) return {}
  const out: ActivitySummary = {}

  const supplier = /\[B\]Поставщик:\[\/B\]\s*(.+)/i.exec(description)?.[1]
  if (supplier) {
    const clean = stripUrl(supplier)
    // «не указан» — наша же заглушка билдера; показывать её в журнале незачем, строка и так пуста.
    if (clean && clean !== 'не указан') out.supplier = clean.slice(0, 200)
  }

  const rows = /\[B\]Позиций:\[\/B\]\s*(\d+)/i.exec(description)
  out.rows = intOrUndefined(rows?.[1])
  const matched = /сопоставлено с каталогом:\s*(\d+)/i.exec(description)
  out.matched = intOrUndefined(matched?.[1])

  const amount = /\[B\]Сумма:\[\/B\]\s*(.+)/i.exec(description)?.[1]
  if (amount) out.amount = stripUrl(amount).slice(0, 60)

  const problems = /\[B\]Проблемы\s*\((\d+)\):\[\/B\]/i.exec(description)
  out.problems = intOrUndefined(problems?.[1])

  const entity = /\[B\][^[]*:\[\/B\]\s*\[URL=([^\]]+)\](.*?)\[\/URL\]/i.exec(
    // ⚠ Ищем ссылку ТОЛЬКО в блоке карточки, а не первую попавшуюся: первой в теле идёт ссылка на
    // компанию поставщика, и без этого журнал вёл бы «Открыть сделку» на карточку контрагента.
    description.split('\n').filter(l => !/\[B\]Поставщик:/i.test(l)).join('\n')
  )
  if (entity) {
    const path = entity[1]?.trim() ?? ''
    // Только относительный путь портала: чужой абсолютный адрес из отредактированного дела увёл бы
    // человека наружу под нашей подписью.
    if (path.startsWith('/')) {
      out.entityPath = path.slice(0, 300)
      out.entityLabel = (entity[2] ?? '').trim().slice(0, 60) || undefined
    }
  }

  return out
}

/** Цвета дела: тот же словарь, что у записи в портале (`todoActivity`). */
export const ACTIVITY_COLOR_CLEAN = '4'
export const ACTIVITY_COLOR_ISSUES = '7'

/**
 * Исход по ЦВЕТУ САМОГО ДЕЛА, а не по признаку «дело закрыто».
 *
 * ⚠ Прежде журнал красил бейдж по `COMPLETED`, и связь была односторонней: цвет, изменённый в
 * портале руками, журнал не видел, и один и тот же импорт выглядел на двух экранах по-разному.
 * Теперь читается `SETTINGS.COLOR` — ровно то, что человек видит в карточке.
 * ⚠ Неизвестный цвет — это НЕ «успех»: у портала жёлтый вообще не имеет цифрового кода, а дело
 * могли перекрасить во что угодно. Возвращаем «не знаем», и подпись говорит именно это.
 */
export function activityOutcome(colorId: unknown): 'clean' | 'issues' | 'unknown' {
  const c = typeof colorId === 'string' ? colorId.trim() : ''
  if (c === ACTIVITY_COLOR_CLEAN) return 'clean'
  if (c === ACTIVITY_COLOR_ISSUES) return 'issues'
  return 'unknown'
}
