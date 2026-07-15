import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { xlsxToText, xlsxToTextFallback, zipUncompressedTotal, XlsxTooLargeError, MAX_XLSX_ENTRIES } from '../server/utils/demoXlsx'
import { extractDemo } from '../app/utils/demoExtract'

async function buildXlsx(rows: Array<Array<string | number>>): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Sheet1')
  rows.forEach(r => ws.addRow(r))
  return new Uint8Array(await wb.xlsx.writeBuffer() as ArrayBuffer)
}

/** Build an .xlsx with several named sheets (each is an array of rows). */
async function buildMultiSheetXlsx(sheets: Array<{ name: string, rows: Array<Array<string | number>> }>): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook()
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name)
    s.rows.forEach(r => ws.addRow(r))
  }
  return new Uint8Array(await wb.xlsx.writeBuffer() as ArrayBuffer)
}

describe('xlsxToText multi-sheet (GH #76)', () => {
  const SHEETS = [
    { name: 'ТТН', rows: [['Поставщик: ООО «Пример»'], ['УНП: 191234567']] },
    { name: 'Приложение', rows: [['Наименование', 'Кол-во', 'Цена'], ['Болт М6', 100, 0.45]] },
    { name: 'Пусто', rows: [] as Array<Array<string | number>> }
  ]
  it('exceljs path reads ALL sheets in order, drops empty, header first', async () => {
    const t = await xlsxToText(await buildMultiSheetXlsx(SHEETS))
    expect(t).toContain('УНП: 191234567') // ТТН sheet (header)
    expect(t).toContain('Болт М6') // Приложение sheet (goods) — was lost before #76
    expect(t.indexOf('УНП')).toBeLessThan(t.indexOf('Болт М6')) // workbook order preserved
    expect(t).not.toMatch(/\n\n\n/) // empty sheet dropped, no blank-line pileup
  })
  it('fallback reader also reads all sheets', () => {
    // Rebuild synchronously via the same bytes — exercise the exceljs-free path directly.
    return buildMultiSheetXlsx(SHEETS).then((bytes) => {
      const t = xlsxToTextFallback(Buffer.from(bytes))
      expect(t).toContain('УНП: 191234567')
      expect(t).toContain('Болт М6')
    })
  })
})

describe('xlsxToText', () => {
  it('first sheet → tab-separated text (header + rows)', async () => {
    const bytes = await buildXlsx([
      ['Наименование', 'Кол-во', 'Цена', 'Сумма'],
      ['Перчатки рабочие', 300, 1.1, 330],
      ['Каска защитная', 40, 9.8, 392]
    ])
    const text = await xlsxToText(bytes)
    expect(text).toContain('Наименование\tКол-во\tЦена\tСумма')
    expect(text.split('\n')).toHaveLength(3)
  })

  it('produces text the deterministic demo extractor parses into items', async () => {
    const bytes = await buildXlsx([
      ['СЧЁТ № 501'],
      ['Поставщик: ООО «Пример»'],
      ['УНП: 191234567'],
      ['Наименование', 'Кол-во', 'Цена', 'Сумма'],
      ['Перчатки рабочие', 300, 1.1, 330],
      ['Каска защитная', 40, 9.8, 392]
    ])
    const r = extractDemo(await xlsxToText(bytes))
    expect(r.docType).toBe('invoice')
    expect(r.items).toHaveLength(2)
    expect(r.supplier?.taxId).toBe('191234567')
  })

  it('empty workbook → empty string (no usable sheet)', async () => {
    const wb = new ExcelJS.Workbook()
    wb.addWorksheet('empty')
    const bytes = new Uint8Array(await wb.xlsx.writeBuffer() as ArrayBuffer)
    expect(await xlsxToText(bytes)).toBe('')
  })

  it('collapses a multiline cell so it does not split the row', async () => {
    const bytes = await buildXlsx([
      ['Наименование', 'Цена'],
      ['Перчатки\nрабочие\nхлопок', 1.1]
    ])
    const text = await xlsxToText(bytes)
    expect(text.split('\n')).toHaveLength(2) // header + one data row, not four
    expect(text).toContain('Перчатки рабочие хлопок\t1.1')
  })

  it('renders a formula result, never «[object Object]»', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('S')
    ws.addRow(['Товар', 'Сумма'])
    const row = ws.addRow(['Перчатки', null])
    row.getCell(2).value = { formula: 'A2*300', result: 690 }
    // An error result must not leak «[object Object]» into the text either.
    const row2 = ws.addRow(['Ошибка', null])
    row2.getCell(2).value = { formula: '1/0', result: { error: '#DIV/0!' } }
    const bytes = new Uint8Array(await wb.xlsx.writeBuffer() as ArrayBuffer)
    const text = await xlsxToText(bytes)
    expect(text).toContain('Перчатки\t690')
    expect(text).not.toContain('[object Object]')
  })

  it('emits a merged range value ONCE, not repeated across spanned columns (GH #66)', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('S')
    ws.mergeCells('A1:D1')
    ws.getCell('A1').value = 'ООО «Пример»'
    ws.addRow(['Наименование', 'Кол-во', 'Цена', 'Сумма'])
    ws.addRow(['Болт', 10, 5, 50])
    const bytes = new Uint8Array(await wb.xlsx.writeBuffer() as ArrayBuffer)
    const text = await xlsxToText(bytes)
    const firstLine = text.split('\n')[0]!
    // The company name appears once, not «ООО «Пример»\tООО «Пример»\t…» across B/C/D.
    expect(firstLine.match(/ООО «Пример»/g)).toHaveLength(1)
  })

  it('de-duplicates multiple merged ranges, including a vertical merge', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('S')
    ws.mergeCells('A1:C1') // horizontal
    ws.getCell('A1').value = 'ШАПКА'
    ws.mergeCells('A2:A3') // vertical
    ws.getCell('A2').value = 'ВЕРТ'
    ws.getCell('B2').value = 'x'
    const bytes = new Uint8Array(await wb.xlsx.writeBuffer() as ArrayBuffer)
    const text = await xlsxToText(bytes)
    expect(text.match(/ШАПКА/g)).toHaveLength(1)
    expect(text.match(/ВЕРТ/g)).toHaveLength(1) // not repeated into A3
  })

  it('parses a real xlsx into a 2-column price list end-to-end', async () => {
    const bytes = await buildXlsx([
      ['Наименование', 'Цена'],
      ['Перчатки рабочие', 1.1],
      ['Каска защитная', 9.8]
    ])
    const r = extractDemo(await xlsxToText(bytes))
    expect(r.items).toHaveLength(2)
    expect(r.items[0]).toMatchObject({ name: 'Перчатки рабочие', price: 1.1 })
  })
})

// The exceljs-free fallback (GH #65): exceljs crashes on some real workbooks (e.g. a
// header/footer logo → "reading 'anchors'"); xlsxToText catches and re-reads with this.
// We can't easily synthesise a crashing workbook, so we test the parser directly against
// exceljs-authored xlsx and assert it yields the SAME cell text the happy path would.
describe('xlsxToTextFallback (exceljs-free reader)', () => {
  it('reads shared strings + numbers into the same TAB-separated shape', async () => {
    const bytes = await buildXlsx([
      ['Наименование', 'Кол-во', 'Цена', 'Сумма'],
      ['Перчатки рабочие', 300, 1.1, 330],
      ['Каска защитная', 40, 9.8, 392]
    ])
    const text = xlsxToTextFallback(Buffer.from(bytes))
    expect(text.split('\n')).toHaveLength(3)
    expect(text).toContain('Наименование\tКол-во\tЦена\tСумма')
    expect(text).toContain('Перчатки рабочие\t300\t1.1\t330')
  })

  it('output feeds the deterministic extractor into items + supplier', async () => {
    const bytes = await buildXlsx([
      ['СЧЁТ № 501'],
      ['Поставщик: ООО «Пример»'],
      ['УНП: 191234567'],
      ['Наименование', 'Кол-во', 'Цена', 'Сумма'],
      ['Перчатки рабочие', 300, 1.1, 330],
      ['Каска защитная', 40, 9.8, 392]
    ])
    const r = extractDemo(xlsxToTextFallback(Buffer.from(bytes)))
    expect(r.items).toHaveLength(2)
    expect(r.supplier?.taxId).toBe('191234567')
  })

  it('decodes XML entities in cell text (& < >)', async () => {
    const bytes = await buildXlsx([['Болт «М6» <усилен> & гайка', 5]])
    const text = xlsxToTextFallback(Buffer.from(bytes))
    expect(text).toContain('Болт «М6» <усилен> & гайка\t5')
  })

  it('non-zip bytes → empty string', () => {
    expect(xlsxToTextFallback(Buffer.from('not a zip'))).toBe('')
  })
})

describe('xlsxToText — DoS budget guard', () => {
  it('zipUncompressedTotal reads a real xlsx central directory', async () => {
    const bytes = await buildXlsx([['Наименование', 'Цена'], ['Болт', 1]])
    const info = zipUncompressedTotal(Buffer.from(bytes))
    expect(info).not.toBeNull()
    expect(info!.total).toBeGreaterThan(0)
    expect(info!.entries).toBeGreaterThan(0)
    expect(info!.entries).toBeLessThanOrEqual(MAX_XLSX_ENTRIES)
  })

  it('rejects an archive with too many entries (bomb by entry-count)', async () => {
    const wb = new ExcelJS.Workbook()
    for (let i = 0; i < MAX_XLSX_ENTRIES + 5; i++) wb.addWorksheet(`S${i}`)
    const bytes = new Uint8Array(await wb.xlsx.writeBuffer() as ArrayBuffer)
    expect(zipUncompressedTotal(Buffer.from(bytes))!.entries).toBeGreaterThan(MAX_XLSX_ENTRIES)
    await expect(xlsxToText(bytes)).rejects.toBeInstanceOf(XlsxTooLargeError)
  })

  it('non-zip bytes → null (let the parser reject them under timeout)', () => {
    expect(zipUncompressedTotal(Buffer.from('not a zip at all'))).toBeNull()
  })
})
