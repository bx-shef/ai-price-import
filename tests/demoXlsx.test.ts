import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { xlsxToText, zipUncompressedTotal, XlsxTooLargeError, MAX_XLSX_ENTRIES } from '../server/utils/demoXlsx'
import { extractDemo } from '../app/utils/demoExtract'

async function buildXlsx(rows: Array<Array<string | number>>): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Sheet1')
  rows.forEach(r => ws.addRow(r))
  return new Uint8Array(await wb.xlsx.writeBuffer() as ArrayBuffer)
}

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
