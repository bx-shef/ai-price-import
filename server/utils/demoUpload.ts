// Pure helpers for the public demo endpoint (extension/size validation + text decode).
// Kept out of the .post.ts handler so they can be unit-tested without an h3 event.

export const MAX_DEMO_BYTES = 5 * 1024 * 1024 // 5 MB — fits a scanned-invoice PDF; rate-limited 3/10min
/** Deterministic (instant, free) formats — decoded/parsed in-process. */
export const DEMO_TEXT_EXT = ['txt', 'csv', 'tsv', 'text']
/** Extensions parsed as a spreadsheet (vs. decoded as text). */
export const DEMO_XLSX_EXT = ['xlsx']
/** AI formats (P5-b): extracted via poppler/libreoffice/OCR → DeepSeek agent. */
export const DEMO_AI_EXT = ['pdf', 'png', 'jpg', 'jpeg', 'docx', 'doc']
export const DEMO_ALLOWED_EXT = [...DEMO_TEXT_EXT, ...DEMO_XLSX_EXT, ...DEMO_AI_EXT]

/** Lower-case extension without the dot, or '' when the name has none. */
export function ext(name: string): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? ''
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}

export interface DemoFileVerdict {
  ok: boolean
  status?: number
  error?: string
}

/** Validate a demo upload by size then extension. Pure. */
export function validateDemoFile(name: string, size: number): DemoFileVerdict {
  if (!size || size <= 0) return { ok: false, status: 400, error: 'Файл пуст.' }
  if (size > MAX_DEMO_BYTES) return { ok: false, status: 413, error: 'Файл слишком большой для демо (до 5 МБ).' }
  if (!DEMO_ALLOWED_EXT.includes(ext(name))) {
    return {
      ok: false,
      status: 415,
      error: 'Демо понимает текст (.txt/.csv), Excel (.xlsx), PDF, сканы (.png/.jpg) и Word (.doc/.docx).'
    }
  }
  return { ok: true }
}

/** Decode bytes as UTF-8, falling back to Windows-1251 for legacy CIS documents. */
export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    // Non-fatal 1251 decoder never throws → this is the definitive fallback.
    return new TextDecoder('windows-1251').decode(bytes)
  }
}
