/**
 * Цвет полосы с итогом пачки (#507).
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. На живом снимке из мобильного приложения полоса говорила «Готово: успешно
 * 0, с ошибкой 1» — **на зелёном фоне**. Цвет выбирался единственным условием «идёт импорт или нет»
 * (`importing ? 'air-primary' : 'air-primary-success'`), то есть исход пачки на него не влиял
 * вообще: любой законченный прогон был зелёным, даже когда не получилось ничего.
 *
 * Это нарушение правила «стоп и предупреждение — разное»: зелёный читается как «всё получилось», и
 * человек уходит с экрана, не заметив, что в CRM не попало ни одной записи. Ошибка тем опаснее, что
 * текст рядом был ПРАВИЛЬНЫЙ — а цвет замечают раньше текста.
 */

/** Что за сообщение показано. Заводится вместе с текстом — см. `setNotice` в `ImportStaging`. */
export type NoticeKind
  /** Служебное: файлы добавлены, предел списка, отправляем такой-то. */
  = | 'info'
  /** Пачка идёт прямо сейчас. */
    | 'running'
  /** Все файлы обработаны без отказов. */
    | 'success'
  /** Часть прошла, часть — нет. Записи в CRM есть, но не все. */
    | 'partial'
  /** Не прошёл НИ ОДИН файл. В CRM не записано ничего. */
    | 'failed'
  /** Человек прервал пачку сам. Это не поломка. */
    | 'cancelled'

/**
 * Исход завершённой пачки по числам.
 *
 * ⚠ Порядок проверок несущий: «ни одного успеха» решается ДО «есть отказы». Иначе прогон, где всё
 * упало, попадал бы в «часть прошла» — жёлтый вместо красного, то есть ровно та же ложь, только
 * тише.
 */
export function runNoticeKind(input: { ok: number, failed: number }): NoticeKind {
  const ok = Math.max(0, Math.trunc(input.ok || 0))
  const failed = Math.max(0, Math.trunc(input.failed || 0))
  if (failed <= 0) return 'success'
  return ok <= 0 ? 'failed' : 'partial'
}

/** Роли `B24Alert`, которыми пользуемся. Union, а не `string`: иначе опечатка в имени роли дошла бы
 *  до браузера и полоса молча осталась бы серой. */
export type NoticeColor
  = | 'air-primary'
    | 'air-primary-success'
    | 'air-primary-warning'
    | 'air-primary-alert'
    | 'air-secondary'

/**
 * Роль цвета `B24Alert` для сообщения.
 *
 * ⚠ Красный — только когда в CRM не записано НИЧЕГО, ровно как велит правило текстов. Жёлтый —
 * «записали, но есть нюанс». Отмену красим нейтрально: человек прервал сам, и красный читался бы
 * как отказ сервиса.
 */
export function noticeColor(kind: NoticeKind): NoticeColor {
  switch (kind) {
    case 'running': return 'air-primary'
    case 'success': return 'air-primary-success'
    case 'partial': return 'air-primary-warning'
    case 'failed': return 'air-primary-alert'
    case 'cancelled': return 'air-secondary'
    default: return 'air-secondary'
  }
}
