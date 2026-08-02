// Pure upload validation core (P5). No DOM/I/O. See docs/PROCESS.md

import { FORMATS_HUMAN, SUPPORTED_EXT, buildAccept } from '~/config/uploadFormats'

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024 // 20 MB
export const MAX_UPLOAD_FILES = 10
/** Formats come from the SHARED list (#341) — the portal used to accept fewer than the landing demo,
 *  so a CSV price-list that «worked» on the landing was rejected right after install. */
export const ALLOWED_EXT = SUPPORTED_EXT

/** `accept` for the file `<input>` — built from the same shared list (MIME first, see the module). */
export const UPLOAD_ACCEPT = buildAccept()

/** Human file size for a staged row («1,2 МБ»). Russian decimal comma, one decimal for МБ/КБ.
 *  Pure — no Intl dependency so the string is stable across environments/tests. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${Math.round(bytes)} Б`
  const kb = bytes / 1024
  if (kb < 1024) return `${Math.round(kb)} КБ`
  return `${(kb / 1024).toFixed(1).replace('.', ',')} МБ`
}

export interface UploadFileMeta { name: string, size: number }
export interface UploadValidation { ok: boolean, error?: string }

/** File extension (lower-case, no dot), or '' if none. */
export function fileExtension(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

/** Validate one file by extension + size. */
export function validateUploadFile(file: UploadFileMeta, maxBytes = MAX_UPLOAD_BYTES): UploadValidation {
  const ext = fileExtension(file.name)
  if (!(ALLOWED_EXT as readonly string[]).includes(ext)) {
    return { ok: false, error: `Такой формат не подходит${ext ? ` (.${ext})` : ''}. Загрузите ${FORMATS_HUMAN}.` }
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return { ok: false, error: 'Файл пустой. Проверьте его на компьютере и загрузите ещё раз.' }
  }
  if (file.size > maxBytes) {
    return { ok: false, error: `Файл слишком большой — можно до ${Math.round(maxBytes / 1024 / 1024)} МБ. Сожмите его или загрузите страницы по частям.` }
  }
  return { ok: true }
}

export interface BatchPlan<T> {
  accepted: T[]
  rejected: Array<{ file: T, error: string }>
  truncated: number
}

/** Split a batch: validate each, cap at MAX_UPLOAD_FILES, report truncation. */
export function planUploadBatch<T extends UploadFileMeta>(files: T[], maxFiles = MAX_UPLOAD_FILES): BatchPlan<T> {
  const head = files.slice(0, maxFiles)
  const truncated = Math.max(0, files.length - maxFiles)
  const accepted: T[] = []
  const rejected: Array<{ file: T, error: string }> = []
  for (const f of head) {
    const v = validateUploadFile(f)
    if (v.ok) accepted.push(f)
    else rejected.push({ file: f, error: v.error! })
  }
  return { accepted, rejected, truncated }
}

/** What one upload attempt ended with, as the staging loop needs to see it. */
export interface UploadOutcome {
  ok: boolean
  /**
   * Stop the whole batch instead of trying the remaining rows.
   *
   * Set when the refusal is about the PERSON, not the file — hitting the upload rate limit. Without
   * it the one-by-one loop kept going and refused every remaining row in turn, each with a wrong
   * «проверьте связь» and each spending another portal REST call to verify the token, ending in
   * «Отправили в CRM 0 из 9».
   */
  stop: boolean
  /** Text for the row. Comes from the server when it explained itself. */
  message?: string
}

/** Fallback text when the server said nothing usable. */
export const UPLOAD_GENERIC_ERROR = 'Не удалось отправить файл — проверьте связь и нажмите «Импортировать» ещё раз.'

/**
 * Classify a failed upload.
 *
 * 429 is the one refusal the batch must not push through: the limit is per person and per window,
 * so the next row would fail for the same reason. Everything else stays per-row and retryable — a
 * broken file must not stop the eight good ones behind it.
 */
export function classifyUploadError(e: unknown, serverMessage?: string): UploadOutcome {
  const status = (e as { statusCode?: number, status?: number })?.statusCode
    ?? (e as { status?: number })?.status
    ?? (e as { response?: { status?: number } })?.response?.status
  const rateLimited = status === 429
  return {
    ok: false,
    stop: rateLimited,
    // On 429 the server's own sentence carries the wait time; never overwrite it with the generic one.
    message: (rateLimited && serverMessage) ? serverMessage : (serverMessage || UPLOAD_GENERIC_ERROR)
  }
}
