import { deflateRawSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'

// exceljs is mocked to ALWAYS throw the real header/footer-drawing crash, so these tests
// exercise the actual xlsxToText → catch → xlsxToTextFallback path (GH #65), not just the
// fallback in isolation. Inputs are hand-built STORED (uncompressed) zips so we can encode
// XML shapes exceljs never writes itself (inlineStr, sparse r="C1", >500 rows).
vi.mock('exceljs', () => ({
  default: {
    Workbook: class {
      xlsx = {
        load: () => Promise.reject(new TypeError('Cannot read properties of undefined (reading \'anchors\')'))
      }
    }
  }
}))

const { xlsxToText, xlsxToTextFallback } = await import('../server/utils/demoXlsx')

/** CRC-32 (IEEE) of a byte buffer — required in the zip headers. */
function crc32(buf: Uint8Array): number {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1))
  }
  return (~c) >>> 0
}

interface ZipSpec { name: string, method: number, stored: Buffer, crc: number, uncompSize: number }

/** Build a valid zip from explicit entry specs (STORED or DEFLATE, size can be forged). */
function zipFrom(specs: ZipSpec[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const s of specs) {
    const nameB = Buffer.from(new TextEncoder().encode(s.name))
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(s.method, 8)
    lh.writeUInt32LE(s.crc, 14)
    lh.writeUInt32LE(s.stored.length, 18) // compressed size
    lh.writeUInt32LE(s.uncompSize, 22)
    lh.writeUInt16LE(nameB.length, 26)
    const local = Buffer.concat([lh, nameB, s.stored])
    locals.push(local)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(s.method, 10)
    ch.writeUInt32LE(s.crc, 16)
    ch.writeUInt32LE(s.stored.length, 20)
    ch.writeUInt32LE(s.uncompSize, 24)
    ch.writeUInt16LE(nameB.length, 28)
    ch.writeUInt32LE(offset, 42)
    centrals.push(Buffer.concat([ch, nameB]))
    offset += local.length
  }
  const localPart = Buffer.concat(locals)
  const centralPart = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(specs.length, 8)
  eocd.writeUInt16LE(specs.length, 10)
  eocd.writeUInt32LE(centralPart.length, 12)
  eocd.writeUInt32LE(localPart.length, 16)
  return Buffer.concat([localPart, centralPart, eocd])
}

/** Build a minimal, valid zip with STORED (method 0) entries. */
function storedZip(files: Record<string, string>): Buffer {
  return zipFrom(Object.entries(files).map(([name, content]) => {
    const data = Buffer.from(new TextEncoder().encode(content))
    return { name, method: 0, stored: data, crc: crc32(data), uncompSize: data.length }
  }))
}

const sheet = (rowsXml: string): string =>
  `<?xml version="1.0"?><worksheet><sheetData>${rowsXml}</sheetData></worksheet>`

describe('xlsxToText falls back when exceljs throws (GH #65)', () => {
  it('routes an exceljs crash to the fallback and returns its text', async () => {
    const buf = storedZip({
      'xl/sharedStrings.xml': '<sst><si><t>Наименование</t></si><si><t>Болт М6</t></si></sst>',
      'xl/worksheets/sheet1.xml': sheet(
        '<row><c r="A1" t="s"><v>0</v></c></row>'
        + '<row><c r="A2" t="s"><v>1</v></c><c r="B2"><v>330</v></c></row>'
      )
    })
    const viaCatch = await xlsxToText(new Uint8Array(buf)) // exceljs mocked → throws → fallback
    const direct = xlsxToTextFallback(buf)
    expect(viaCatch).toBe(direct)
    expect(viaCatch).toContain('Наименование')
    expect(viaCatch).toContain('Болт М6\t330')
  })
})

describe('xlsxToTextFallback — XML shapes exceljs never authors', () => {
  it('resolves inline strings (t="inlineStr")', () => {
    const buf = storedZip({
      'xl/worksheets/sheet1.xml': sheet('<row><c r="A1" t="inlineStr"><is><t>Перчатки</t></is></c><c r="B1"><v>5</v></c></row>')
    })
    expect(xlsxToTextFallback(buf)).toBe('Перчатки\t5')
  })

  it('honours the cell reference to leave a gap for a skipped column (A1 + C1)', () => {
    // B1 is absent → an empty middle column must be preserved so B stays a column, not
    // collapsed (the surrounding tabs survive; only leading/trailing are trimmed).
    const buf = storedZip({
      'xl/worksheets/sheet1.xml': sheet('<row><c r="A1" t="inlineStr"><is><t>Товар</t></is></c><c r="C1"><v>99</v></c></row>')
    })
    expect(xlsxToTextFallback(buf)).toBe('Товар\t\t99')
  })

  it('keeps t="str" formula strings and blanks t="e" error cells', () => {
    const buf = storedZip({
      'xl/worksheets/sheet1.xml': sheet('<row><c r="A1" t="str"><v>ИТОГО</v></c><c r="B1" t="e"><v>#DIV/0!</v></c><c r="C1"><v>7</v></c></row>')
    })
    expect(xlsxToTextFallback(buf)).toBe('ИТОГО\t\t7')
  })

  it('caps output at MAX_XLSX_ROWS (500) even for a taller sheet', () => {
    const rows = Array.from({ length: 620 }, (_, i) => `<row><c r="A${i + 1}"><v>${i}</v></c></row>`).join('')
    const buf = storedZip({ 'xl/worksheets/sheet1.xml': sheet(rows) })
    expect(xlsxToTextFallback(buf).split('\n')).toHaveLength(500)
  })

  it('reads ALL worksheets in NUMERIC file order (sheet2 before sheet10), GH #76', () => {
    const buf = storedZip({
      'xl/worksheets/sheet10.xml': sheet('<row><c r="A1" t="inlineStr"><is><t>ДЕСЯТЫЙ</t></is></c></row>'),
      'xl/worksheets/sheet2.xml': sheet('<row><c r="A1" t="inlineStr"><is><t>ВТОРОЙ</t></is></c></row>')
    })
    // All sheets are joined; numeric file order (sheet2 before sheet10, not lexicographic).
    expect(xlsxToTextFallback(buf)).toBe('ВТОРОЙ\nДЕСЯТЫЙ')
  })

  it('a merged cell keeps its value once (in the top-left), others stay blank', () => {
    // Excel stores the value only in the anchor cell; mergeCells metadata is irrelevant to text.
    const buf = storedZip({
      'xl/worksheets/sheet1.xml': sheet('<row><c r="A1" t="inlineStr"><is><t>ЕДИНЫЙ ЗАГОЛОВОК</t></is></c></row>')
        .replace('</sheetData>', '</sheetData><mergeCells count="1"><mergeCell ref="A1:D1"/></mergeCells>')
    })
    expect(xlsxToTextFallback(buf)).toBe('ЕДИНЫЙ ЗАГОЛОВОК')
  })

  it('concatenates multi-run inline strings (<is><r><t>A<r><t>B → "AB")', () => {
    const buf = storedZip({
      'xl/worksheets/sheet1.xml': sheet('<row><c r="A1" t="inlineStr"><is><r><t>Пер</t></r><r><t>чатки</t></r></is></c></row>')
    })
    expect(xlsxToTextFallback(buf)).toBe('Перчатки')
  })

  it('unwraps CDATA and does not entity-decode its literal content', () => {
    const buf = storedZip({
      'xl/sharedStrings.xml': '<sst><si><t><![CDATA[Болт & <М6>]]></t></si></sst>',
      'xl/worksheets/sheet1.xml': sheet('<row><c r="A1" t="s"><v>0</v></c></row>')
    })
    expect(xlsxToTextFallback(buf)).toBe('Болт & <М6>')
  })
})

describe('xlsxToTextFallback — hardening (public endpoint, untrusted input)', () => {
  it('is linear-time on malformed XML with unclosed tags (no ReDoS)', () => {
    // The old lazy-regex parser was O(n²): ~6s on 700KB. indexOf scanning is O(n).
    const evil = '<worksheet><sheetData>' + '<row><c>'.repeat(300_000) // ~2.4MB, never closes
    const buf = storedZip({ 'xl/worksheets/sheet1.xml': evil })
    const start = performance.now()
    const out = xlsxToTextFallback(buf)
    const ms = performance.now() - start
    expect(out).toBe('') // no complete <row>…</row> → nothing
    expect(ms).toBeLessThan(2000) // generous CI margin; real runtime is a few ms
  })

  it('refuses a decompression bomb — inflate is capped, does not fill memory', () => {
    // 60MB of one byte compresses to a few KB. The central-directory size is FORGED small
    // so it slips past zipUncompressedTotal — the inflate cap is the real guard.
    const huge = Buffer.alloc(60 * 1024 * 1024, 0x61)
    const deflated = deflateRawSync(huge)
    const bomb = zipFrom([
      { name: 'xl/worksheets/sheet1.xml', method: 8, stored: deflated, crc: crc32(huge), uncompSize: 100 }
    ])
    expect(() => xlsxToTextFallback(bomb)).toThrow() // maxOutputLength → ERR_BUFFER_TOO_LARGE
  })

  it('caps a single giant cell so the output line cannot explode', () => {
    const giant = 'Я'.repeat(200_000)
    const buf = storedZip({
      'xl/worksheets/sheet1.xml': sheet(`<row><c r="A1" t="inlineStr"><is><t>${giant}</t></is></c></row>`)
    })
    expect(xlsxToTextFallback(buf).length).toBeLessThanOrEqual(32_768)
  })
})
