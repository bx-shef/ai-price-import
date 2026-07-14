// Pure format routing for file-extract: pick an extraction strategy by file
// extension, orchestrate the runners (pdftotext / office / OCR). The actual
// subprocess/IO is INJECTED (ExtractRunners) → this core is unit-tested with fakes.
// docs/redesign 02 §4 (file-extract) + 06 (OCR rus+bel+kaz+eng).

export type ExtractKind = 'text' | 'pdf' | 'office' | 'image' | 'unsupported'

export interface ExtractPlan { kind: ExtractKind, ext: string }

const EXT_KIND: Record<string, ExtractKind> = {
  txt: 'text', csv: 'text', tsv: 'text',
  pdf: 'pdf',
  doc: 'office', docx: 'office', xls: 'office', xlsx: 'office', odt: 'office', ods: 'office', rtf: 'office',
  png: 'image', jpg: 'image', jpeg: 'image', tif: 'image', tiff: 'image', bmp: 'image', webp: 'image'
}

/** Below this many non-space chars a PDF is treated as scanned → OCR fallback. */
export const MIN_PDF_TEXT = 32

/** Route a file to an extraction strategy by its extension (lower-cased). */
export function planExtraction(fileName: string): ExtractPlan {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase().trim()
  return { kind: EXT_KIND[ext] ?? 'unsupported', ext }
}

export interface ExtractRunners {
  /** Decode a plain-text/csv file (windows-1251 or utf-8) to a string. */
  readText: (path: string) => Promise<string>
  /** pdftotext → layout text. */
  pdfToText: (path: string) => Promise<string>
  /** Office/spreadsheet → text (libreoffice). `fileName` (with its real extension) chooses
   *  the export filter — `path` may be an extension-less temp file (e.g. `<jobId>.bin`). */
  officeToText: (path: string, fileName: string) => Promise<string>
  /** OCR an image / scanned PDF (tesseract rus+bel+kaz+eng). */
  ocr: (path: string) => Promise<string>
}

/**
 * Extract DOCUMENT_TEXT from a stored file. A PDF that yields almost no text is
 * treated as scanned and re-run through OCR (common for invoices). Throws on an
 * unsupported format (caller fails the job with the message).
 */
export async function extractText(path: string, fileName: string, runners: ExtractRunners): Promise<string> {
  const { kind } = planExtraction(fileName)
  switch (kind) {
    case 'text':
      return runners.readText(path)
    case 'pdf': {
      const text = await runners.pdfToText(path)
      return text.replace(/\s/g, '').length >= MIN_PDF_TEXT ? text : runners.ocr(path)
    }
    case 'office':
      return runners.officeToText(path, fileName)
    case 'image':
      return runners.ocr(path)
    default:
      throw new Error(`неподдерживаемый формат файла: ${fileName || '(без имени)'}`)
  }
}
