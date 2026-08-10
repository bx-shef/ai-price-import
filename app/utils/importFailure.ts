import { isPortalAccessDenied, isPortalTypeUnavailable } from './portalErrors'
// Turning a raw Bitrix24 REST error into something an employee can act on (#269).
//
// The worker used to write `сбой обработки: <текст портала>` verbatim, so a portal without smart
// invoices produced «сбой обработки: Сущность CRM не поддерживается» — no mention of which target was
// chosen, at which step it broke, or what to do next. The chosen target is what makes the message
// actionable: by the time the error appears the employee no longer remembers what they picked.

/** Target as it is stored with the job (manual override) — only the type matters for the message. */
export interface FailureTarget {
  entityTypeId?: number | null
}

/** Nominative name of a target type, for «Не удалось внести документ в …». */
export function targetTypeName(entityTypeId: number | null | undefined): string {
  switch (entityTypeId) {
    case 1: return 'Лид'
    case 2: return 'Сделку'
    case 31: return 'Смарт-счёт'
    default:
      return Number.isInteger(entityTypeId) && (entityTypeId as number) >= 1000 ? 'Смарт-процесс' : 'выбранную запись'
  }
}

/** Whether we can name this target type at all (system type or a smart process). A stale/unknown id
 *  has no readable name — the UI then shows nothing rather than a meaningless «выбранную запись». */
export function isKnownTargetType(entityTypeId: number | null | undefined): boolean {
  return entityTypeId === 1 || entityTypeId === 2 || entityTypeId === 31
    || (Number.isInteger(entityTypeId) && (entityTypeId as number) >= 1000)
}

// Portal answers that mean «this CRM TYPE is not available here», in the wordings B24 actually uses.
// A bare NOT_FOUND is deliberately NOT here: it is B24's most common generic code (товар, компания,
// стадия, файл на Диске…), and routing all of those into «выберите другую цель» would hand out a
// wrong instruction far more often than a right one.
// ⚠ Формулировки — из ОБЩЕГО словаря (`portalErrors.ts`): тот же список решает, попадёт ли документ
// в CRM через запасную сделку (`server/utils/targetFallback.ts`). Две копии отвечали бы по-разному
// на один и тот же ответ портала — человеку одно, коду другое.

/** Cap on the raw portal text quoted back to the user (the row is one line). */
const MAX_PORTAL_DETAIL = 200

/**
 * Human explanation for a failed import, with the raw portal text kept as a technical detail rather
 * than as the whole message. `raw` is the error text; `target` the manual override, when there was one.
 */
export function describeImportFailure(raw: string, target?: FailureTarget | null): string {
  // Collapse whitespace and cap: the portal can answer with a multi-line dump, and this string is
  // rendered inside a one-line row. The worker already slices its input, this is the second guard.
  const text = (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_PORTAL_DETAIL)
  const where = targetTypeName(target?.entityTypeId)
  const detail = text ? ` Ответ Битрикс24: ${text}` : ''

  // ACCESS first: an access error can mention a missing entity too, and «выберите другую цель» would
  // send the employee down the wrong path when the real fix is «попросите открыть доступ».
  if (isPortalAccessDenied(text)) {
    return `Не удалось внести документ в «${where}» — не хватает прав в CRM. Попросите администратора `
      + `открыть доступ к этому разделу и загрузите файл снова.${detail}`
  }
  if (isPortalTypeUnavailable(text)) {
    return `Не удалось внести документ в «${where}» — этот тип записи недоступен на вашем портале `
      + `или был удалён. Выберите другую цель (например, Сделку) и загрузите файл снова.${detail}`
  }
  // Unknown answer: still say WHERE it was going and that the file can be re-sent — that alone is
  // more than the old «сбой обработки: <текст>».
  return `Не удалось внести документ в «${where}». Попробуйте загрузить файл снова; если повторится — `
    + `покажите это сообщение администратору.${detail}`
}
