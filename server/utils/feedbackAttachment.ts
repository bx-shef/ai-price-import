// Решение «приложить ли документ к отзыву и какой» — ЧИСТАЯ функция с внедрёнными зависимостями
// (#461, разбор тестировщика).
//
// Почему вынесено из роута. Внутри `defineEventHandler` эта ветка была недостижима тестом, и её
// сторожил грep по исходнику («роут зовёт `fetchActivityFile(jobId, member.userId`»). Такой гард
// ловит удаление или переименование строки — и НЕ ловит подмену значения: одна строка
// `member.userId = raw.context.userId ?? member.userId` перед вызовом оставляла бы литерал на
// месте, проходила бы гард и открывала доступ к документу ЧУЖОГО сотрудника. Теперь идентификатор
// сотрудника — параметр этой функции, и его происхождение проверяется поведением, а не текстом.
//
// Здесь же закреплён порядок, который легко переставить местами и не заметить: сначала читаем
// документ, и только потом тратим общий часовой предел приёмника (#354). Обратный порядок мерил бы
// НАМЕРЕНИЕ вместо расхода — шестьдесят пустых запросов «с файлом» выключали бы вложения всем
// клиентам, ничего не стоив отправителю.

import { fetchActivityFile, type ActivityFileDeps } from './activityFileFetch'

export interface AttachmentDeps {
  /** REST к порталу под его OAuth-токеном; `null` — приложение не установлено. */
  resolveCall: () => Promise<ActivityFileDeps['call'] | null>
  /** Приёмник подтверждён приватным? Спрашивается ДО чтения байт (#200). */
  uploadAllowed: () => Promise<boolean>
  /** Общий часовой предел приёмника (#354). */
  checkBudget: () => Promise<{ allowed: boolean, notice?: string }>
  /** Положить байты в приёмник; возвращает адрес файла. */
  commit: (name: string, base64: string) => Promise<string | null>
  download: ActivityFileDeps['download']
  originatorCode: string
  maxBytes: number
  /** Текст «отзыв принят, но документ не приложен» — общий для всех причин промаха. */
  missingNotice: string
  /** Куда сообщить КЛАСС промаха (без имени файла и адреса — это данные клиента). */
  logMiss?: (miss: string) => void
}

export interface AttachmentResult {
  /** Адрес приложенного документа в приёмнике, если он туда доехал. */
  fileUrl?: string
  /** Что сказать человеку, если документ НЕ доехал. */
  notice?: string
}

/**
 * Resolve the document to attach to a feedback issue.
 *
 * ⚠ `userId` обязан приходить из ПРОВЕРЕННОГО фрейм-токена, а `jobId` — от клиента: сужение по
 * сотруднику это единственное, что мешает назвать чужое задание своим, и снаружи ошибка в эту
 * сторону неотличима — отзыв уходит успешно в обоих случаях.
 * ⚠ Молчания быть не должно: попросили приложить, а файла нет — человеку это говорят. Иначе
 * «Спасибо за отзыв!» читается как «документ ушёл».
 * ⚠ Ошибки не выбрасываются наружу: отзыв ценнее вложения и обязан уйти в любом случае.
 */
export async function resolveFeedbackAttachment(
  jobId: string,
  userId: unknown,
  deps: AttachmentDeps
): Promise<AttachmentResult> {
  try {
    const call = await deps.resolveCall()
    if (!call) return { notice: deps.missingNotice }
    if (!await deps.uploadAllowed()) return { notice: deps.missingNotice }

    const got = await fetchActivityFile(jobId, userId, {
      call,
      download: deps.download,
      originatorCode: deps.originatorCode,
      maxBytes: deps.maxBytes
    })
    if (!got.ok) {
      deps.logMiss?.(got.miss)
      return { notice: deps.missingNotice }
    }

    // Предел приёмника тратится ПОСЛЕ того, как документ реально прочитан (см. шапку модуля).
    const budget = await deps.checkBudget()
    // ⚠ Своя причина, если она названа; иначе общий текст — но МОЛЧАНИЯ быть не должно.
    if (!budget.allowed) return { notice: budget.notice || deps.missingNotice }

    const url = await deps.commit(got.file.name, got.file.base64)
    return url ? { fileUrl: url } : { notice: deps.missingNotice }
  } catch {
    return { notice: deps.missingNotice }
  }
}
