import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { xlsxToText } from '../server/utils/demoXlsx'
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
})
