import { describe, expect, it } from 'vitest'
import { officeConvertTarget } from '../server/utils/extractRunners'

describe('officeConvertTarget', () => {
  it('exports spreadsheets as CSV with PINNED tab/UTF-8 options so the grid + prices survive (GH #64)', () => {
    for (const p of ['/tmp/x.xls', '/tmp/x.xlsx', '/tmp/x.ods', '/tmp/x.xlsm', '/tmp/x.fods']) {
      const t = officeConvertTarget(p)
      expect(t.outExt).toBe('csv')
      // TAB field separator (9) — never collides with a decimal comma; UTF-8 (76).
      expect(t.filter).toBe('csv:Text - txt - csv (StarCalc):9,34,76,,,,,,,,,-1')
    }
  })

  it('exports text documents with the plain-text filter', () => {
    for (const p of ['/tmp/x.doc', '/tmp/x.docx', '/tmp/x.odt', '/tmp/x.rtf']) {
      expect(officeConvertTarget(p)).toEqual({ filter: 'txt:Text', outExt: 'txt' })
    }
  })

  it('is case-insensitive on the extension', () => {
    expect(officeConvertTarget('/tmp/EXPORT.XLS').outExt).toBe('csv')
  })

  it('picks the filter from the fileName, so a spreadsheet works even from a .bin path (GH #74)', () => {
    // officeToText passes the real fileName (not the extension-less <jobId>.bin on disk).
    expect(officeConvertTarget('Прайс.xls')).toEqual({ filter: 'csv:Text - txt - csv (StarCalc):9,34,76,,,,,,,,,-1', outExt: 'csv' })
  })

  it('falls back to the text filter for a name without an extension', () => {
    expect(officeConvertTarget('noext')).toEqual({ filter: 'txt:Text', outExt: 'txt' })
  })
})
