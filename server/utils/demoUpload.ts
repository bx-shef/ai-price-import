// Pure helpers for the public demo endpoint (extension/size validation + text decode).
// Kept out of the .post.ts handler so they can be unit-tested without an h3 event.

export const MAX_DEMO_BYTES = 1024 * 1024 // 1 MB — plenty for a text document
export const DEMO_ALLOWED_EXT = ['txt', 'csv', 'tsv', 'text']

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
  if (size > MAX_DEMO_BYTES) return { ok: false, status: 413, error: 'Файл слишком большой для демо (до 1 МБ текста).' }
  if (!DEMO_ALLOWED_EXT.includes(ext(name))) {
    return {
      ok: false,
      status: 415,
      error: 'Демо понимает текстовые выгрузки (.txt/.csv). Для PDF/сканов/Excel — полная версия внутри Bitrix24.'
    }
  }
  return { ok: true }
}

/** Decode bytes as UTF-8, falling back to Windows-1251 for legacy CIS documents. */
export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    try {
      return new TextDecoder('windows-1251').decode(bytes)
    } catch {
      return new TextDecoder('utf-8').decode(bytes) // last resort, lossy
    }
  }
}
