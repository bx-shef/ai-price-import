import { inflateRawSync } from 'node:zlib'
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
  try {
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
  } catch (err) {
    if (err instanceof XlsxTooLargeError) throw err
    // exceljs crashes on some valid workbooks — notably a header/footer drawing
    // (`vmlDrawingHF*.vml`, a logo in the print header) trips "Cannot read properties of
    // undefined (reading 'anchors')" during load. Common on real invoice templates. Fall
    // back to a minimal, dependency-free reader that only needs the cell text (GH #65).
    return xlsxToTextFallback(buf)
  }
}

// ── Minimal xlsx → text fallback (no exceljs) ────────────────────────────────────────
// An .xlsx is a zip of XML. We read only sharedStrings + the first worksheet, resolve
// cell values, and emit the same TAB-separated shape as the exceljs path. This sidesteps
// exceljs bugs (e.g. header/footer drawings) for the demo's text-only needs. Guarded by
// the same pre-parse bomb budget in xlsxToText; here we inflate just two entries.

interface ZipEntry { method: number, compSize: number, localOffset: number }

/** Map every zip entry name → its central-directory record. Null if not a zip. */
function zipIndex(buf: Buffer): Record<string, ZipEntry> | null {
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
  let off = buf.readUInt32LE(eocd + 16)
  const index: Record<string, ZipEntry> = {}
  for (let n = 0; n < entries; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CDR_SIG) return null
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOffset = buf.readUInt32LE(off + 42)
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen)
    index[name] = { method, compSize, localOffset }
    off += 46 + nameLen + extraLen + commentLen
  }
  return index
}

/** Inflate one zip entry (stored or raw-deflate) to a UTF-8 string. */
function readZipEntry(buf: Buffer, e: ZipEntry): string {
  // Local file header: 30 fixed bytes + name + extra (its own lengths, not the CDR's).
  const nameLen = buf.readUInt16LE(e.localOffset + 26)
  const extraLen = buf.readUInt16LE(e.localOffset + 28)
  const start = e.localOffset + 30 + nameLen + extraLen
  const raw = buf.subarray(start, start + e.compSize)
  const out = e.method === 0 ? raw : inflateRawSync(raw)
  return out.toString('utf8')
}

/** Decode the five predefined XML entities (+ numeric refs). */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&') // last, so "&amp;lt;" → "&lt;" not "<"
}

/** Parse sharedStrings.xml into an index → text array (concatenating rich-text runs). */
function parseSharedStrings(xml: string): string[] {
  const out: string[] = []
  const siRe = /<si>([\s\S]*?)<\/si>/g
  let si: RegExpExecArray | null
  while ((si = siRe.exec(xml))) {
    let text = ''
    const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g
    let t: RegExpExecArray | null
    while ((t = tRe.exec(si[1] ?? ''))) text += t[1] ?? ''
    out.push(decodeXmlEntities(text))
  }
  return out
}

/** "B12" → zero-based column index (11). Returns -1 without a column letter. */
function columnIndex(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref)?.[1]
  if (!letters) return -1
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/** Parse the worksheet XML into TAB-separated rows, resolving shared strings. */
function parseSheet(xml: string, shared: string[]): string {
  const lines: string[] = []
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g
  let row: RegExpExecArray | null
  let rowCount = 0
  while ((row = rowRe.exec(xml))) {
    if (rowCount >= MAX_XLSX_ROWS) break
    rowCount++
    const cells: string[] = []
    // Match both empty (<c .../>) and valued (<c ...>…</c>) cells.
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
    let c: RegExpExecArray | null
    let seq = 0
    while ((c = cellRe.exec(row[1] ?? ''))) {
      const attrs = c[1] ?? ''
      const body = c[2] ?? ''
      const ref = /r="([^"]+)"/.exec(attrs)?.[1] ?? ''
      const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? 'n'
      const vMatch = /<v>([\s\S]*?)<\/v>/.exec(body)
      let value = ''
      if (type === 's') {
        if (vMatch) value = shared[Number(vMatch[1] ?? '')] ?? ''
      } else if (type === 'inlineStr') {
        const t = /<t[^>]*>([\s\S]*?)<\/t>/.exec(body)?.[1]
        if (t) value = decodeXmlEntities(t)
      } else if (type === 'e') {
        value = '' // error cell (#N/A, #REF!) → blank
      } else if (vMatch) {
        value = decodeXmlEntities(vMatch[1] ?? '') // number / date-serial / boolean / formula result
      }
      const col = ref ? columnIndex(ref) : seq
      const at = col >= 0 ? col : seq
      if (at < MAX_XLSX_COLS) cells[at] = clean(value)
      seq++
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] == null) cells[i] = ''
    lines.push(cells.join('\t'))
  }
  return lines.join('\n').trim()
}

/** exceljs-free reader: first worksheet of an .xlsx → TAB-separated text. */
export function xlsxToTextFallback(buf: Buffer): string {
  const index = zipIndex(buf)
  if (!index) return ''
  const shared = index['xl/sharedStrings.xml']
    ? parseSharedStrings(readZipEntry(buf, index['xl/sharedStrings.xml']))
    : []
  const sheetName = Object.keys(index)
    .filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort()[0]
  const sheet = sheetName ? index[sheetName] : undefined
  if (!sheet) return ''
  return parseSheet(readZipEntry(buf, sheet), shared)
}
