import { describe, expect, it } from 'vitest'
import { officeConvertTarget, parseOfficeCsvOutputs } from '../server/utils/extractRunners'

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

describe('parseOfficeCsvOutputs (workbook sheet order, GH #76)', () => {
  it('keeps multi-sheet paths in the order libreoffice printed (NOT alphabetical)', () => {
    // libreoffice prints sheets in workbook index order; the header sheet «ТТН» must stay
    // first even though it sorts LAST alphabetically.
    const stdout = [
      'convert /tmp/x/f.xls as a Calc document using filter : Text - txt - csv (StarCalc):9,34,76,,,,,,,,,-1',
      'Writing sheet ТТН -> /tmp/x/f-ТТН.csv',
      'Writing sheet Приложение -> /tmp/x/f-Приложение.csv',
      'Writing sheet ИнформационныйЛист -> /tmp/x/f-ИнформационныйЛист.csv'
    ].join('\n')
    expect(parseOfficeCsvOutputs(stdout)).toEqual([
      '/tmp/x/f-ТТН.csv', '/tmp/x/f-Приложение.csv', '/tmp/x/f-ИнформационныйЛист.csv'
    ])
  })

  it('parses the single-sheet "convert … -> …csv using filter :…" line shape', () => {
    const stdout = 'convert /tmp/x/f.xls -> /tmp/x/f.csv using filter : Text - txt - csv (StarCalc):9,34,76'
    expect(parseOfficeCsvOutputs(stdout)).toEqual(['/tmp/x/f.csv'])
  })

  it('handles a sheet name with spaces and ignores non-csv / noise lines', () => {
    const stdout = [
      'Warning: failed to launch javaldx',
      'Writing sheet Лист 1 -> /tmp/x/f-Лист 1.csv',
      'some unrelated -> /tmp/x/thing.txt'
    ].join('\n')
    expect(parseOfficeCsvOutputs(stdout)).toEqual(['/tmp/x/f-Лист 1.csv'])
  })

  it('returns [] when nothing matches (caller falls back to readdir/base file)', () => {
    expect(parseOfficeCsvOutputs('nothing here\njust logs')).toEqual([])
  })
})
