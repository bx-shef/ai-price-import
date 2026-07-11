import ExcelJS from 'exceljs'

// Read the first worksheet of an .xlsx as TAB-separated text (header + rows) so the
// deterministic demo parser — which detects \t/;/,/| tables — can extract it. Public
// endpoint: row/column caps bound a decompression/XML bomb; the file is already size-
// capped upstream and the backend container is memory-limited. No formulas are evaluated.

export const MAX_XLSX_ROWS = 500
export const MAX_XLSX_COLS = 40

/** One cell → plain text (handles rich text, hyperlinks, formula results, dates). */
function cellText(v: unknown): string {
  if (v == null) return ''
  if (v instanceof Date) return v.toLocaleDateString('ru-RU')
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (Array.isArray(o.richText)) return (o.richText as Array<{ text?: string }>).map(t => t.text ?? '').join('')
    if (typeof o.text === 'string') return o.text // hyperlink label
    if ('result' in o) return o.result == null ? '' : String(o.result) // formula → cached result
    return '' // error cell / unknown object shape
  }
  return String(v)
}

/** Convert xlsx bytes to tab-separated text. Returns '' when there is no usable sheet. */
export async function xlsxToText(bytes: Uint8Array): Promise<string> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer)
  const ws = wb.worksheets[0]
  if (!ws) return ''
  const lines: string[] = []
  let count = 0
  ws.eachRow({ includeEmpty: false }, (row) => {
    if (count >= MAX_XLSX_ROWS) return
    count++
    // row.values is 1-based (index 0 empty); slice to the column cap, fill holes with ''.
    const vals = Array.isArray(row.values) ? row.values.slice(1, MAX_XLSX_COLS + 1) : []
    lines.push(vals.map(cellText).join('\t'))
  })
  return lines.join('\n').trim()
}
