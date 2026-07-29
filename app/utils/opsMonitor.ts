// Чистая обвязка операторской консоли (#271). Логика мелкая, но именно её отсутствие делало экран
// бесполезным: данные грузились один раз на монтировании, и оператор смотрел на замороженный снимок,
// не понимая, что тот устарел.

/** Как часто консоль подтягивает состояние очередей. Не чаще: три запроса на цикл. */
export const QUEUES_REFRESH_MS = 12_000
/** Через сколько само гаснет сообщение о результате действия. */
export const FLASH_MS = 4_000
/** После какого возраста снимок считаем устаревшим (два пропущенных цикла + запас). */
export const STALE_AFTER_MS = QUEUES_REFRESH_MS * 3

/** Время последнего обновления как «14:03:27». Пусто, если обновления ещё не было. */
export function formatClock(ms: number | null | undefined, locale = 'ru-RU'): string {
  if (!ms || !Number.isFinite(ms)) return ''
  return new Date(ms).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/**
 * Устарел ли снимок. Нужен именно признак, а не только отметка времени: если автообновление
 * поставили на паузу или запросы молча перестали доходить, цифры на экране продолжают выглядеть
 * свежими — а это ровно тот случай, ради которого консоль и открывают.
 */
export function staleAfter(updatedAt: number | null | undefined, now: number = Date.now(), limit = STALE_AFTER_MS): boolean {
  if (!updatedAt || !Number.isFinite(updatedAt)) return false // обновления ещё не было — это не «устарело»
  return now - updatedAt > limit
}

/**
 * Реальная пропускная способность на портал — упирается в ограничитель Битрикс24 (около 2 запросов
 * в секунду при ~8 запросах на документ), а не в очередь. Подтверждено `pnpm loadtest:queue`.
 */
export const DOCS_PER_HOUR_PER_PORTAL = 900

/**
 * Во что превращается текущая глубина очереди по времени. Вместо полосы с выдуманной шкалой
 * (множитель без единиц, где 12 задач = 100%) оператор видит то, что можно сопоставить с реальностью.
 * Оценка НИЖНЯЯ: задачи разных порталов идут параллельно, каждый со своим ограничителем.
 */
export function backlogHours(pending: number, perHour: number = DOCS_PER_HOUR_PER_PORTAL): string {
  if (!Number.isFinite(pending) || pending <= 0) return ''
  const minutes = Math.round((pending / perHour) * 60)
  if (minutes < 1) return 'меньше минуты работы'
  if (minutes < 60) return `${minutes} мин работы`
  // Округляем ДО выбора формата, иначе 9.96 ч печаталось бы как «10.0 ч», а 10.0 — как «10 ч»:
  // два разных написания у соседних значений.
  const hours = Math.round((minutes / 60) * 10) / 10
  return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} ч работы`
}
