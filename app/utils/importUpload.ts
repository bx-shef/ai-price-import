// Pure upload validation core (P5). No DOM/I/O. See docs/PROCESS.md

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024 // 20 MB
export const MAX_UPLOAD_FILES = 10
export const ALLOWED_EXT = ['pdf', 'png', 'jpg', 'jpeg', 'xlsx', 'xls', 'docx'] as const

/** `accept` for the file `<input>`. Includes MIME TYPES first, then the extensions. On MOBILE (Bitrix24
 *  app / phone browser) an extension-only accept greys out otherwise-valid files (the OS matches by MIME,
 *  not extension) — so a phone user «can't pick a file». Listing MIME types fixes that; `image/*` also
 *  surfaces the camera so a document can be photographed. The server still re-validates by extension
 *  (validateUploadFile), so this only widens what the picker OFFERS, never what is accepted. */
export const UPLOAD_ACCEPT = [
  'application/pdf',
  'image/*',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel', // .xls
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  '.pdf', '.png', '.jpg', '.jpeg', '.xlsx', '.xls', '.docx'
].join(',')

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
    return { ok: false, error: `Такой формат не подходит${ext ? ` (.${ext})` : ''}. Загрузите PDF, фото, Excel или Word.` }
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
