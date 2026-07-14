import { inflateRawSync } from 'node:zlib'
import ExcelJS from 'exceljs'

// Read the first worksheet of an .xlsx as TAB-separated text so the deterministic demo
// parser (detects \t/;/,/| tables) can extract it. PUBLIC endpoint → hardened against a
// zip/XML decompression bomb: an xlsx is a zip of XML and a ~1MB file can inflate to
// hundreds of MB. Guards, both for the exceljs path AND the exceljs-free fallback:
//  1) zipUncompressedTotal() rejects before parsing if the DECLARED sizes exceed budget;
//  2) every inflate is bounded by maxOutputLength (the declared size is untrusted, so we
//     never rely on it alone — a forged-small size still can't expand past the cap);
//  3) the fallback parser scans XML with indexOf only (no backtracking regex) → O(n), and
//     caps rows/cols/cell-length, so it can't wedge the single JS thread. No formulas run.

export const MAX_XLSX_ROWS = 500
export const MAX_XLSX_COLS = 40
export const MAX_XLSX_UNCOMPRESSED = 40 * 1024 * 1024 // 40 MB expanded — reject bombs
export const MAX_XLSX_ENTRIES = 128
/** Cap a single cell's text so one giant cell can't blow up the output line. */
const MAX_CELL_CHARS = 32_768
const PARSE_TIMEOUT_MS = 5000

/** Thrown when the xlsx would expand past the demo budget (endpoint → 413). */
export class XlsxTooLargeError extends Error {
  constructor() {
    super('xlsx expands beyond the demo budget')
    this.name = 'XlsxTooLargeError'
  }
}

interface CdRecord { name: string, method: number, compSize: number, uncompSize: number, localOffset: number }

/**
 * Walk the zip End-of-Central-Directory + Central Directory WITHOUT decompressing.
 * Returns the declared entry count and one record per entry (empty records when the count
 * exceeds the cap — we refuse to walk a suspicious archive). Null when it's not a zip.
 * Shared by zipUncompressedTotal (bomb budget) and the fallback reader (entry lookup).
 */
function readCentralDirectory(buf: Buffer): { entryCount: number, records: CdRecord[] } | null {
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
  const entryCount = buf.readUInt16LE(eocd + 10)
  if (entryCount > MAX_XLSX_ENTRIES) return { entryCount, records: [] }
  let off = buf.readUInt32LE(eocd + 16)
  const records: CdRecord[] = []
  for (let n = 0; n < entryCount; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CDR_SIG) return null
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const uncompSize = buf.readUInt32LE(off + 24)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOffset = buf.readUInt32LE(off + 42)
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen)
    records.push({ name, method, compSize, uncompSize, localOffset })
    off += 46 + nameLen + extraLen + commentLen
  }
  return { entryCount, records }
}

/**
 * Sum uncompressed sizes from the central directory so a highly-compressible bomb is
 * caught pre-parse. NB: these sizes are DECLARED (untrusted) — this is a fast pre-filter,
 * not the only guard; every actual inflate is separately capped (see readZipEntry).
 * Returns null when the bytes don't parse as a zip.
 */
export function zipUncompressedTotal(buf: Buffer): { total: number, entries: number } | null {
  const cd = readCentralDirectory(buf)
  if (!cd) return null
  if (cd.entryCount > MAX_XLSX_ENTRIES) return { total: Infinity, entries: cd.entryCount }
  let total = 0
  for (const r of cd.records) {
    total += r.uncompSize
    if (total > MAX_XLSX_UNCOMPRESSED) return { total, entries: cd.entryCount }
  }
  return { total, entries: cd.entryCount }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('xlsx parse timeout')), ms))
  ])
}

/** Collapse intra-cell whitespace (a multiline cell would otherwise split a row). */
function clean(s: string): string {
  return s.replace(/[\t\r\n]+/g, ' ').trim().slice(0, MAX_CELL_CHARS)
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
    // undefined (reading 'anchors')" during load. Also catches its parse timeout. Fall
    // back to a minimal, dependency-free reader that only needs the cell text (GH #65).
    // The fallback is O(n) and inflate-capped, so it's safe to run on untrusted input.
    return xlsxToTextFallback(buf)
  }
}

// ── Minimal xlsx → text fallback (no exceljs) ────────────────────────────────────────
// An .xlsx is a zip of XML. We read only sharedStrings + the first worksheet, resolve
// cell values, and emit the same TAB-separated shape as the exceljs path. XML is scanned
// with indexOf only (NOT backtracking regex like /([\s\S]*?)<\/tag>/, which is O(n²) and
// a DoS vector on a public endpoint) → linear time. Every inflate is length-capped.

/** Inflate one zip entry (stored or raw-deflate) to a UTF-8 string, output length-capped. */
function readZipEntry(buf: Buffer, e: CdRecord): string {
  // Local file header: 30 fixed bytes + name + extra (its OWN lengths, not the CDR's).
  const nameLen = buf.readUInt16LE(e.localOffset + 26)
  const extraLen = buf.readUInt16LE(e.localOffset + 28)
  const start = e.localOffset + 30 + nameLen + extraLen
  const raw = buf.subarray(start, start + e.compSize)
  // maxOutputLength: the declared size is untrusted, so cap the inflate itself. Over the
  // cap → throws (bubbles to the caller's catch → honest error), never fills memory.
  const out = e.method === 0
    ? raw.subarray(0, MAX_XLSX_UNCOMPRESSED)
    : inflateRawSync(raw, { maxOutputLength: MAX_XLSX_UNCOMPRESSED })
  return out.toString('utf8')
}

/** Strip CDATA wrappers (their content is literal), keeping the inner text. O(n), indexOf. */
function stripCdata(s: string): string {
  if (s.indexOf('<![CDATA[') < 0) return s
  let out = ''
  let i = 0
  while (i < s.length) {
    const open = s.indexOf('<![CDATA[', i)
    if (open < 0) {
      out += s.slice(i)
      break
    }
    out += s.slice(i, open)
    const close = s.indexOf(']]>', open + 9)
    if (close < 0) {
      out += s.slice(open + 9)
      break
    }
    out += s.slice(open + 9, close)
    i = close + 3
  }
  return out
}

/** Decode the five predefined XML entities (+ numeric refs). Runs after CDATA stripping. */
function decodeXmlEntities(s: string): string {
  if (s.indexOf('&') < 0) return s
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&') // last, so "&amp;lt;" → "&lt;" not "<"
}

/** Concatenate every <t>…</t> run inside xml[start,end). O(n), indexOf-based (no regex). */
function collectRunText(xml: string, start: number, end: number): string {
  let text = ''
  let i = start
  while (i < end && text.length < MAX_CELL_CHARS) {
    const open = xml.indexOf('<t', i)
    if (open < 0 || open >= end) break
    const nextChar = xml[open + 2]
    if (nextChar !== '>' && nextChar !== ' ' && nextChar !== '/') {
      i = open + 2 // <table>, not <t>
      continue
    }
    const gt = xml.indexOf('>', open)
    if (gt < 0 || gt >= end) break
    if (xml[gt - 1] === '/') {
      i = gt + 1 // self-closed <t/>
      continue
    }
    const closeT = xml.indexOf('</t>', gt + 1)
    if (closeT < 0 || closeT > end) break
    text += xml.slice(gt + 1, closeT)
    i = closeT + 4
  }
  return decodeXmlEntities(stripCdata(text))
}

/** Read the content of the first <v>…</v> inside a cell body. O(n), indexOf-based. */
function firstValue(body: string): string | null {
  const open = body.indexOf('<v>')
  if (open < 0) return null
  const close = body.indexOf('</v>', open + 3)
  if (close < 0) return null
  return body.slice(open + 3, close)
}

/** Parse sharedStrings.xml into an index → text array (concatenating rich-text runs). */
function parseSharedStrings(xml: string): string[] {
  const out: string[] = []
  let i = 0
  while (out.length < 4 * MAX_XLSX_ROWS * MAX_XLSX_COLS) {
    const open = xml.indexOf('<si>', i)
    if (open < 0) break
    const close = xml.indexOf('</si>', open + 4)
    if (close < 0) break
    out.push(collectRunText(xml, open + 4, close))
    i = close + 5
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

/** Resolve one cell (attrs + optional body) to plain text. */
function cellValue(attrs: string, body: string, shared: string[]): string {
  const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? 'n'
  if (type === 's') {
    const v = firstValue(body)
    return v == null ? '' : (shared[Number(v)] ?? '')
  }
  if (type === 'inlineStr') return collectRunText(body, 0, body.length)
  if (type === 'e') return '' // error cell (#N/A, #REF!) → blank
  const v = firstValue(body)
  return v == null ? '' : decodeXmlEntities(v) // number / date-serial / boolean / str result
}

/** Parse one <row> inner XML into a TAB-joined line. O(n), indexOf-based (no regex). */
function parseRow(rowXml: string, shared: string[]): string {
  const cells: string[] = []
  let i = 0
  let seq = 0
  while (seq <= MAX_XLSX_COLS * 4) {
    const open = rowXml.indexOf('<c', i)
    if (open < 0) break
    const nextChar = rowXml[open + 2]
    if (nextChar !== '>' && nextChar !== ' ' && nextChar !== '/') {
      i = open + 2 // <col>, not <c>
      continue
    }
    const gt = rowXml.indexOf('>', open)
    if (gt < 0) break
    const selfClosed = rowXml[gt - 1] === '/'
    const attrs = rowXml.slice(open + 2, selfClosed ? gt - 1 : gt)
    let body = ''
    if (selfClosed) {
      i = gt + 1
    } else {
      const close = rowXml.indexOf('</c>', gt + 1)
      if (close < 0) break
      body = rowXml.slice(gt + 1, close)
      i = close + 4
    }
    const ref = /r="([^"]+)"/.exec(attrs)?.[1] ?? ''
    const col = ref ? columnIndex(ref) : seq
    const at = col >= 0 ? col : seq
    if (at < MAX_XLSX_COLS) cells[at] = clean(cellValue(attrs, body, shared))
    seq++
  }
  for (let k = 0; k < cells.length; k++) if (cells[k] == null) cells[k] = ''
  return cells.join('\t')
}

/** Parse the worksheet XML into TAB-separated rows. O(n), indexOf-based (no regex). */
function parseSheet(xml: string, shared: string[]): string {
  const lines: string[] = []
  let i = 0
  while (lines.length < MAX_XLSX_ROWS) {
    const open = xml.indexOf('<row', i)
    if (open < 0) break
    const gt = xml.indexOf('>', open)
    if (gt < 0) break
    if (xml[gt - 1] === '/') {
      i = gt + 1 // empty <row/>
      continue
    }
    const close = xml.indexOf('</row>', gt + 1)
    if (close < 0) break
    lines.push(parseRow(xml.slice(gt + 1, close), shared))
    i = close + 6
  }
  return lines.join('\n').trim()
}

/** exceljs-free reader: first worksheet of an .xlsx → TAB-separated text. */
export function xlsxToTextFallback(buf: Buffer): string {
  const cd = readCentralDirectory(buf)
  if (!cd || cd.entryCount > MAX_XLSX_ENTRIES) return ''
  const byName: Record<string, CdRecord> = {}
  for (const r of cd.records) byName[r.name] = r
  const shared = byName['xl/sharedStrings.xml']
    ? parseSharedStrings(readZipEntry(buf, byName['xl/sharedStrings.xml']))
    : []
  // Lowest sheetN.xml = first worksheet. Sort NUMERICALLY (string sort puts sheet10
  // before sheet2), so the first sheet is picked even on a workbook that starts at sheet2.
  const sheetName = cd.records
    .map(r => r.name)
    .filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)![1]) - Number(b.match(/(\d+)\.xml$/)![1]))[0]
  const sheet = sheetName ? byName[sheetName] : undefined
  if (!sheet) return ''
  return parseSheet(readZipEntry(buf, sheet), shared)
}
