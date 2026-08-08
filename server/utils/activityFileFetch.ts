// Чтение исходного документа ИЗ ДЕЛА таймлайна (#461).
//
// Зачем это вообще есть. Своей копии документа у приложения нет: воркер удаляет байты сразу после
// извлечения текста (#349), а архива на Диске больше не существует (#458). До этой правки файл к
// отзыву присылала сама страница из памяти — и оставалась дыра: перезагрузил вкладку до отправки
// отзыва, и отзыв уходил без документа, то есть ровно без того, по чему издатель мог бы
// воспроизвести прогон. Теперь документ вложен в дело таймлайна у КАЖДОГО импорта, включая тот,
// где файл не разобрался, — и берётся оттуда.
//
// ⚠ ГЛАВНАЯ ЛОВУШКА, живая находка (портал `b24-hrbvzq`, 08.08.2026): портал отвечает на
// негодный токен **200 и HTML-страницей входа**, а не 401/403. Наивная проверка `response.ok`
// отправила бы в репозиторий-приёмник страницу логина вместо счёта — молча, при зелёных тестах.
// Поэтому исход решают ТИП СОДЕРЖИМОГО и РАЗМЕР, а не код ответа.

import { isSafeB24Domain, normaliseHost } from './b24Rest'
import { ownActivityFilter } from './todoActivity'

/** Скачанный ответ портала в том виде, в каком его судит ядро. */
export interface DownloadedBody {
  status: number
  contentType: string
  /** Голые байты тела. */
  bytes: Uint8Array
}

export interface ActivityFileDeps {
  /** REST к порталу под ЕГО OAuth-токеном. */
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>
  /** Скачивание по адресу вложения. */
  download: (url: string) => Promise<DownloadedBody>
  originatorCode: string
  /** Предел размера вложения к отзыву. */
  maxBytes: number
}

/** Почему файл не доехал — для журнала, наружу человеку уходит один общий текст. */
export type ActivityFileMiss
  = | 'no-activity' | 'no-file' | 'unsafe-url' | 'too-big' | 'login-page' | 'download-failed'

export interface ActivityFile {
  name: string
  base64: string
}

/**
 * Типы содержимого, которые НЕ являются документом ни при каких условиях.
 *
 * ⚠ Список запретительный, а не разрешительный, и это осознанно: документы приезжают под самыми
 * разными типами (`application/pdf`, `application/octet-stream`, `text/plain` у csv), и белый
 * список выбрасывал бы законные файлы. Отсечь надо ровно одно — страницу входа портала.
 */
const REFUSED_CONTENT_TYPES = ['text/html', 'application/xhtml+xml']

function looksLikeLoginPage(contentType: string): boolean {
  const t = contentType.toLowerCase()
  return REFUSED_CONTENT_TYPES.some(bad => t.includes(bad))
}

/**
 * Read the first attachment of the import activity that belongs to this employee.
 *
 * ⚠ Выборка сужена `RESPONSIBLE_ID` из ПРОВЕРЕННОГО фрейм-токена, а не из тела запроса: `jobId`
 * присылает клиент, и без сужения сотрудник, назвав чужой идентификатор задания, вытянул бы чужой
 * документ. Это несущая проверка, и она не видна глазами — отзыв уходит успешно в обоих случаях.
 * ⚠ Дело ищется списком (там стоит сужение), а поля читаются `crm.activity.get` по найденному id:
 * состав полей у списка не проверен вживую, а у `get` вложения наблюдались. Лишний вызов дешевле
 * догадки.
 * ⚠ Адрес вложения проверяется на принадлежность облаку Битрикс24 (`isSafeB24Domain`): он приходит
 * из ответа портала, но по нему мы ходим СВОИМ процессом — подменённый адрес увёл бы серверный
 * запрос на чужой хост.
 * ⚠ Размер сверяется ДО и ПОСЛЕ скачивания: заявленный портал может не прислать вовсе, а
 * фактический — единственный, которому можно верить.
 * ⚠ Любая неудача — `miss`, а не исключение: отзыв ценнее вложения и обязан уйти в любом случае.
 */
export async function fetchActivityFile(
  jobId: string,
  responsibleId: unknown,
  deps: ActivityFileDeps
): Promise<{ ok: true, file: ActivityFile } | { ok: false, miss: ActivityFileMiss }> {
  const filter = ownActivityFilter(deps.originatorCode, jobId, responsibleId)
  const list = await deps.call('crm.activity.list', { filter, select: ['ID'], start: 0 })
  const rows = Array.isArray(list) ? list : (list as { items?: unknown } | null)?.items
  const first = Array.isArray(rows) ? rows[0] as { ID?: unknown, id?: unknown } | undefined : undefined
  const activityId = Number(first?.ID ?? first?.id)
  if (!Number.isInteger(activityId) || activityId <= 0) return { ok: false, miss: 'no-activity' }

  const full = await deps.call('crm.activity.get', { id: activityId }) as { FILES?: unknown } | null
  const files = full?.FILES
  const file = (Array.isArray(files) ? files[0] : undefined) as
    { url?: unknown, urlDownload?: unknown, name?: unknown, size?: unknown } | undefined
  const url = typeof file?.url === 'string' && file.url
    ? file.url
    : (typeof file?.urlDownload === 'string' ? file.urlDownload : '')
  if (!url) return { ok: false, miss: 'no-file' }

  let host: string
  try {
    host = normaliseHost(new URL(url).host)
  } catch {
    return { ok: false, miss: 'unsafe-url' }
  }
  if (!isSafeB24Domain(host)) return { ok: false, miss: 'unsafe-url' }

  const declared = Number(file?.size)
  if (Number.isFinite(declared) && declared > deps.maxBytes) return { ok: false, miss: 'too-big' }

  let body: DownloadedBody
  try {
    body = await deps.download(url)
  } catch {
    return { ok: false, miss: 'download-failed' }
  }
  // ⚠ Код ответа НЕ решает ничего: страница входа приезжает с кодом 200 (живая находка).
  if (looksLikeLoginPage(body.contentType)) return { ok: false, miss: 'login-page' }
  if (body.status !== 200 || body.bytes.length === 0) return { ok: false, miss: 'download-failed' }
  if (body.bytes.length > deps.maxBytes) return { ok: false, miss: 'too-big' }

  const name = typeof file?.name === 'string' && file.name.trim() ? file.name.trim() : `${jobId}.bin`
  return { ok: true, file: { name, base64: Buffer.from(body.bytes).toString('base64') } }
}

/** Timeout for one attachment download. */
export const ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 30_000

/**
 * Live downloader over `fetch`.
 *
 * ⚠ Адрес вложения несёт СВОЙ ключ доступа (`auth` в строке запроса) — это проверено живьём и
 * поэтому свой токен сюда не подставляется: лишний секрет в исходящем запросе ничего не открывает
 * и только расширяет то, что может утечь.
 * ⚠ Срок ограничен: загрузка идёт внутри обработки отзыва, и зависший портал держал бы запрос
 * сотрудника до самого края.
 */
export async function downloadAttachment(url: string): Promise<DownloadedBody> {
  const res = await fetch(url, { signal: AbortSignal.timeout(ATTACHMENT_DOWNLOAD_TIMEOUT_MS) })
  const bytes = new Uint8Array(await res.arrayBuffer())
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', bytes }
}
