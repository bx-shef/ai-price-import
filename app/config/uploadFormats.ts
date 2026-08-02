// THE list of file formats the product accepts — one source for both surfaces (#341).
//
// Why this module exists: the landing demo and the in-portal import kept their own arrays, written
// at different times and never compared. The demo accepted CSV/TXT/`.doc` and the portal did not, so
// a prospect could try their CSV price-list on the landing, see it work, install the app — and get
// the same file rejected. The promise came before the install, the refusal after it.
//
// The extraction pipeline itself was never the limitation: `textExtract.planExtraction` has routed
// `txt/csv/tsv` (plain text) and `doc` (libreoffice) since day one. Only the two front gates
// disagreed. A guard test asserts both gates and the pipeline stay in step.

/** Every extension the product accepts, on the landing demo AND in the portal. */
export const SUPPORTED_EXT = [
  // Paper: what a scanned/received document looks like.
  'pdf', 'png', 'jpg', 'jpeg',
  // Office: modern + legacy (the legacy ones go through libreoffice, not the fast readers).
  'xlsx', 'xls', 'docx', 'doc',
  // Plain text / tables: a price-list export. Cheapest and fastest path — no OCR, no LLM.
  'csv', 'tsv', 'txt'
] as const

export type SupportedExt = typeof SUPPORTED_EXT[number]

/**
 * MIME types for the file picker's `accept`. Listing MIME **and** extension matters on mobile
 * (Bitrix24 app / phone browser): the OS matches by MIME there, and an extension-only accept greys
 * out perfectly valid files — the user simply «can't pick a file». `image/*` additionally surfaces
 * the camera so a document can be photographed. Both gates still re-validate by extension, so this
 * only widens what the picker OFFERS, never what is accepted.
 */
export const EXT_MIME: Partial<Record<SupportedExt, string>> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  txt: 'text/plain'
}

/** `accept` string for a file `<input>`: MIME types first, then every supported extension. */
export function buildAccept(): string {
  const mimes = Object.values(EXT_MIME)
  return [...mimes, 'image/*', ...SUPPORTED_EXT.map(e => `.${e}`)].join(',')
}

/** Human-readable format list for UI copy («PDF, фото, Excel, Word, CSV»). Kept next to the list so
 *  a new format can't be added without deciding how it is named to the user. */
export const FORMATS_HUMAN = 'PDF, фото, Excel, Word, CSV'

/**
 * Cap on the file a 👍/👎 may carry (#349 review). ONE number for both ends: the widget refuses to
 * promise an attachment it cannot send, and the route refuses to store one it did not expect. Two
 * independent constants would drift silently — and the failure is invisible, because an oversized
 * attachment is simply dropped and the feedback still files «successfully».
 *
 * Deliberately far below MAX_UPLOAD_BYTES (20 MB): an attachment exists to REPRODUCE a run, not to
 * archive it, and it rides inside a JSON body (base64 is ~4/3 of the bytes).
 */
export const MAX_FEEDBACK_FILE_BYTES = 5 * 1024 * 1024
