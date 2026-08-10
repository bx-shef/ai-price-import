// Как читать отказ портала: ОДИН словарь формулировок на весь проект (#492, разбор ревью).
//
// ⚠ Копий было ТРИ, и они уже разошлись: `importFailure.UNSUPPORTED_PATTERNS` знал «Смарт-процесс не
// найден», `typeLookup.probeSmartInvoiceEnabled` — только «не поддерживается», а заведённый следом
// `targetFallback` — свой четвёртый набор. Расхождение не косметическое: один и тот же список решает
// ДВА разных вопроса — «попадёт ли документ в CRM вообще» (запасная сделка) и «что сказать
// сотруднику», — и разъехавшись, они начинают отвечать по-разному на один ответ портала.
//
// ⚠ Голый `NOT_FOUND` сюда НЕ входит и входить не должен: это самый частый общий код Битрикс24
// (товар, компания, стадия, файл на Диске), и трактовать его как «типа нет» значит раздавать неверный
// совет чаще, чем верный, — а в ветке запасной сделки ещё и создавать запись там, где портал просто
// икнул.

/** Ответы портала, означающие «такого типа CRM здесь нет» — в формулировках, которые он реально даёт. */
export const PORTAL_TYPE_UNAVAILABLE = [
  /сущность\s+crm\s+не\s+поддерживается/i,
  /entity\s+.*not\s+supported/i,
  /ENTITY_TYPE_NOT_SUPPORTED/i,
  /CRM_ENTITY_TYPE_NOT_FOUND/i,
  /смарт-процесс\s+не\s+найден/i
]

/** Ответы портала, означающие «не хватает прав». ⚠ Подчёркнутая форма `ACCESS_DENIED` обязательна
 *  отдельно: `b24Rest.isAuthRejection` ловит только вариант с пробелом, и код из ответа REST мимо
 *  него проходил. */
export const PORTAL_ACCESS_DENIED = [/access\s*denied/i, /ACCESS_DENIED/, /нет\s+прав/i]

/** Портал сказал «такого типа здесь нет»? */
export function isPortalTypeUnavailable(text: string): boolean {
  return PORTAL_TYPE_UNAVAILABLE.some(re => re.test(text))
}

/** Портал сказал «не хватает прав»? */
export function isPortalAccessDenied(text: string): boolean {
  return PORTAL_ACCESS_DENIED.some(re => re.test(text))
}
