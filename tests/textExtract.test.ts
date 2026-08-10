import { describe, expect, it, vi } from 'vitest'
import { extractText, MIN_PDF_TEXT, planExtraction, type ExtractRunners } from '../server/utils/textExtract'

describe('planExtraction', () => {
  it('routes by extension (case-insensitive)', () => {
    expect(planExtraction('a.PDF').kind).toBe('pdf')
    expect(planExtraction('invoice.xlsx').kind).toBe('office')
    expect(planExtraction('1c-export.xls').kind).toBe('office') // GH #64: legacy binary Excel
    expect(planExtraction('scan.JPEG').kind).toBe('image')
    expect(planExtraction('data.csv').kind).toBe('text')
    expect(planExtraction('archive.zip').kind).toBe('unsupported')
    expect(planExtraction('noext').kind).toBe('unsupported')
  })
})

// ⚠ Заглушки НЕ трёхбуквенные (#506). После того как извлечение стало отвергать файл, из которого
// не осталось читаемого текста, маркеры вида 'TXT' сами попадали под этот отказ — тест падал не на
// маршрутизации, а на пороге. Строки удлинены до правдоподобных; проверяется по-прежнему КУДА ушёл
// вызов, а не что именно вернулось.
function runners(over: Partial<ExtractRunners> = {}): ExtractRunners {
  return {
    readText: vi.fn(async () => 'TXT: накладная №5, позиций 3'),
    pdfToText: vi.fn(async () => 'PDFTEXT that is long enough to be real content here'),
    officeToText: vi.fn(async () => 'OFFICE: прайс поставщика, 12 строк'),
    ocr: vi.fn(async () => 'OCR: скан счёта на 500 BYN'),
    ...over
  }
}

describe('extractText', () => {
  it('text → readText', async () => {
    expect(await extractText('/f.txt', 'f.txt', runners())).toContain('TXT')
  })
  it('office → officeToText, passing BOTH the (bin) path and the real fileName (GH #74)', async () => {
    const r = runners()
    // In-portal the stored file is extension-less (<jobId>.bin); the fileName carries the
    // real extension used to pick the export filter.
    expect(await extractText('/data/abc123.bin', 'Прайс.xls', r)).toContain('OFFICE')
    expect(r.officeToText).toHaveBeenCalledWith('/data/abc123.bin', 'Прайс.xls')
  })
  it('office text doc (.docx) at a .bin path also passes the real fileName', async () => {
    const r = runners()
    expect(await extractText('/data/xyz.bin', 'Договор.docx', r)).toContain('OFFICE')
    expect(r.officeToText).toHaveBeenCalledWith('/data/xyz.bin', 'Договор.docx')
  })
  it('image → ocr', async () => {
    expect(await extractText('/f.png', 'f.png', runners())).toContain('OCR')
  })
  it('digital PDF (enough text) → pdfToText, no OCR', async () => {
    const r = runners()
    expect(await extractText('/f.pdf', 'f.pdf', r)).toContain('PDFTEXT')
    expect(r.ocr).not.toHaveBeenCalled()
  })
  it('scanned PDF (little text) → OCR fallback', async () => {
    const r = runners({ pdfToText: vi.fn(async () => '   \n  ') })
    expect(await extractText('/f.pdf', 'f.pdf', r)).toContain('OCR')
    expect(r.ocr).toHaveBeenCalled()
  })
  it('PDF text exactly at threshold is kept (not OCR)', async () => {
    const r = runners({ pdfToText: vi.fn(async () => 'x'.repeat(MIN_PDF_TEXT)) })
    await extractText('/f.pdf', 'f.pdf', r)
    expect(r.ocr).not.toHaveBeenCalled()
  })
  it('unsupported → throws with the file name', async () => {
    await expect(extractText('/f.zip', 'f.zip', runners())).rejects.toThrow(/неподдерживаемый формат/)
  })
})
