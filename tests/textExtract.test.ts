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

function runners(over: Partial<ExtractRunners> = {}): ExtractRunners {
  return {
    readText: vi.fn(async () => 'TXT'),
    pdfToText: vi.fn(async () => 'PDFTEXT that is long enough to be real content here'),
    officeToText: vi.fn(async () => 'OFFICE'),
    ocr: vi.fn(async () => 'OCR'),
    ...over
  }
}

describe('extractText', () => {
  it('text → readText', async () => {
    expect(await extractText('/f.txt', 'f.txt', runners())).toBe('TXT')
  })
  it('office → officeToText', async () => {
    expect(await extractText('/f.xlsx', 'f.xlsx', runners())).toBe('OFFICE')
  })
  it('image → ocr', async () => {
    expect(await extractText('/f.png', 'f.png', runners())).toBe('OCR')
  })
  it('digital PDF (enough text) → pdfToText, no OCR', async () => {
    const r = runners()
    expect(await extractText('/f.pdf', 'f.pdf', r)).toContain('PDFTEXT')
    expect(r.ocr).not.toHaveBeenCalled()
  })
  it('scanned PDF (little text) → OCR fallback', async () => {
    const r = runners({ pdfToText: vi.fn(async () => '   \n  ') })
    expect(await extractText('/f.pdf', 'f.pdf', r)).toBe('OCR')
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
