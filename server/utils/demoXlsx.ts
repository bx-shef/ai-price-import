import ExcelJS from 'exceljs'

// Read the first worksheet of an .xlsx as TAB-separated text so the deterministic demo
// parser (detects \t/;/,/| tables) can extract it. PUBLIC endpoint → hardened against a
// zip/XML decompression bomb: an xlsx is a zip of XML and a ~1MB file can inflate to
// hundreds of MB. The row/col caps only trim the OUTPUT and run AFTER exceljs has
// materialised the whole workbook — so they are NOT the bomb guard. Two real guards:
//  1) zipUncompressedTotal() sums the central-directory uncompressed sizes WITHOUT
//     decompressing, and we reject before exceljs.load() if it exceeds the budget;
//  2) a hard parse timeout bounds CPU. No formulas are evaluated.

export const MAX_XLSX_ROWS = 500
export const MAX_XLSX_COLS = 40
export const MAX_XLSX_UNCOMPRESSED = 40 * 1024 * 1024 // 40 MB expanded — reject bombs
export const MAX_XLSX_ENTRIES = 128
const PARSE_TIMEOUT_MS = 5000

/** Thrown when the xlsx would expand past the demo budget (endpoint → 413). */
export class XlsxTooLargeError extends Error {
  constructor() {
    super('xlsx expands beyond the demo budget')
    this.name = 'XlsxTooLargeError'
  }
}

/**
 * Sum uncompressed sizes from the zip End-of-Central-Directory + Central Directory,
 * WITHOUT decompressing anything, so a highly-compressible bomb is caught pre-parse.
 * Returns null when the bytes don't parse as a zip (let exceljs reject it under timeout).
 */
export function zipUncompressedTotal(buf: Buffer): { total: number, entries: number } | null {
  const EOCD_SIG = 0x06054b50
  const CDR_SIG = 0x02014b50
  const floor = Math.max(0, buf.length - 22 - 0xffff)
  let eocd = -1
  for (let i = buf.length - 22; i >= floor; i--) {
    if (i + 4 <= buf.length && buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0 || eocd + 20 > buf.length) return null
  const entries = buf.readUInt16LE(eocd + 10)
  if (entries > MAX_XLSX_ENTRIES) return { total: Infinity, entries }
  let off = buf.readUInt32LE(eocd + 16)
  let total = 0
  for (let n = 0; n < entries; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CDR_SIG) return null
    total += buf.readUInt32LE(off + 24) // uncompressed size (uint32 LE)
    if (total > MAX_XLSX_UNCOMPRESSED) return { total, entries }
    off += 46 + buf.readUInt16LE(off + 28) + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32)
  }
  return { total, entries }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('xlsx parse timeout')), ms))
  ])
}

/** Collapse intra-cell whitespace (a multiline cell would otherwise split a row). */
function clean(s: string): string {
  return s.replace(/[\t\r\n]+/g, ' ').trim()
}

/** One cell → plain text (rich text, hyperlinks, formula results incl. errors, dates). */
function rawCellText(v: unknown): string {
  if (v == null) return ''
  if (v instanceof Date) return v.toLocaleDateString('ru-RU')
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (Array.isArray(o.richText)) return (o.richText as Array<{ text?: string }>).map(t => t.text ?? '').join('')
    if (typeof o.text === 'string') return o.text // hyperlink label
    if ('result' in o) return typeof o.result === 'object' ? rawCellText(o.result) : (o.result == null ? '' : String(o.result))
    return '' // error cell / unknown object shape
  }
  return String(v)
}

const cellText = (v: unknown): string => clean(rawCellText(v))

/** Convert xlsx bytes to tab-separated text. Throws XlsxTooLargeError over budget. */
export async function xlsxToText(bytes: Uint8Array): Promise<string> {
  const buf = Buffer.from(bytes)
  const budget = zipUncompressedTotal(buf)
  if (budget && (budget.total > MAX_XLSX_UNCOMPRESSED || budget.entries > MAX_XLSX_ENTRIES)) {
    throw new XlsxTooLargeError()
  }
  const wb = new ExcelJS.Workbook()
  await withTimeout(wb.xlsx.load(buf as unknown as ArrayBuffer), PARSE_TIMEOUT_MS)
  const ws = wb.worksheets[0]
  if (!ws) return ''
  const lines: string[] = []
  let count = 0
  ws.eachRow({ includeEmpty: false }, (row) => {
    if (count >= MAX_XLSX_ROWS) return
    count++
    const vals = Array.isArray(row.values) ? row.values.slice(1, MAX_XLSX_COLS + 1) : []
    lines.push(vals.map(cellText).join('\t'))
  })
  return lines.join('\n').trim()
}
