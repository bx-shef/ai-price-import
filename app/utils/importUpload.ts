// Pure upload validation core (P5). No DOM/I/O. See docs/redesign 02 §4.

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024 // 20 MB
export const MAX_UPLOAD_FILES = 10
export const ALLOWED_EXT = ['pdf', 'png', 'jpg', 'jpeg', 'xlsx', 'xls', 'docx'] as const

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
    return { ok: false, error: `Неподдерживаемый формат: .${ext || '—'}` }
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return { ok: false, error: 'Пустой файл' }
  }
  if (file.size > maxBytes) {
    return { ok: false, error: `Файл больше ${Math.round(maxBytes / 1024 / 1024)} МБ` }
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
