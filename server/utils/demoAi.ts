import type { ExtractedDocument } from '~/types/document'
import type { DemoResult, DemoDocType, DemoItem, TaxIdKind } from '~/utils/demoExtract'

// AI path for the PUBLIC demo (P5-b): PDF / scan / office → text extraction
// (poppler / libreoffice / OCR) → DeepSeek agent → structured result, OR an honest
// error. The deterministic path (text / xlsx → demoExtract) stays for instant, free
// extraction. Pure mapper + DI orchestrator (unit-tested with fakes); the real
// extract + agent spawns run only in the backend image (verified in prod, like the
// in-portal pipeline). Rate-limited + no storage — enforced by the route.

const TAX_KIND_MAP: Record<string, TaxIdKind> = { INN: 'ИНН', UNP: 'УНП', BIN: 'БИН', IIN: 'ИИН' }

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Map the agent's free-text documentType to the demo's coarse taxonomy + a label. */
export function classifyDemoDocType(t: string | undefined): { type: DemoDocType, label: string } {
  const s = (t ?? '').toLowerCase()
  if (/наклад|ттн|товарно|жүкқұжат/.test(s)) return { type: 'waybill', label: t || 'Накладная' }
  if (/сч[её]т|инвойс|фактур|рахун|шот/.test(s)) return { type: 'invoice', label: t || 'Счёт' }
  if (/кп|предлож|оферт|ұсын|прапанов/.test(s)) return { type: 'quote', label: t || 'Коммерческое предложение' }
  return { type: 'unknown', label: t || 'Документ' }
}

/** Map an agent ExtractedDocument to the demo UI's DemoResult shape. Pure. */
export function extractedToDemoResult(doc: ExtractedDocument): DemoResult {
  const { type, label } = classifyDemoDocType(doc.documentType)
  const items: DemoItem[] = (doc.items ?? []).map((it) => {
    const sum = Number.isFinite(it.quantity) && Number.isFinite(it.price)
      ? round2(it.quantity * it.price)
      : undefined
    return {
      name: it.name?.trim() || '(без наименования)',
      article: it.article || undefined,
      quantity: Number.isFinite(it.quantity) ? it.quantity : undefined,
      unit: it.unit || undefined,
      price: Number.isFinite(it.price) ? it.price : undefined,
      sum
    }
  })
  // Only surface a grand total when at least one line produced a computable sum.
  // A price list (прайс) is name+price with no quantities → every line sum=undefined;
  // reporting "Итого: 0" there would be misleading, so omit the total instead.
  const anySum = items.some(i => i.sum !== undefined)
  const totalSum = items.reduce((a, i) => a + (i.sum ?? 0), 0)
  const s = doc.supplier
  const supplier = s && (s.name || s.taxId)
    ? {
        name: s.name || undefined,
        taxId: s.taxId || undefined,
        taxIdKind: s.taxIdKind ? TAX_KIND_MAP[s.taxIdKind] : undefined
      }
    : undefined
  return {
    docType: type,
    docTypeLabel: label,
    supplier,
    items,
    totals: { sum: anySum ? round2(totalSum) : undefined },
    language: 'unknown',
    warnings: []
  }
}

/** The subset of a runAgent outcome the orchestrator consumes. */
export interface DemoAgentOutcome {
  ok: boolean
  document: ExtractedDocument | null
  error?: string
}

export interface DemoAiDeps {
  /** Persist the upload to a temp path (extract runners are path-based); returns the path. */
  writeTemp: (bytes: Uint8Array, ext: string) => Promise<string>
  /** Extract DOCUMENT_TEXT from the temp file (poppler / libreoffice / OCR by extension). */
  extractText: (path: string, fileName: string) => Promise<string>
  /** Run the DeepSeek agent over the extracted text. */
  runAgent: (documentText: string) => Promise<DemoAgentOutcome>
  /** Remove the temp file (best-effort). */
  cleanup: (path: string) => Promise<void>
}

/** Lower-case extension without the dot, for the temp file name (fallback 'bin'). */
function extOf(fileName: string): string {
  const base = (fileName ?? '').split(/[\\/]/).pop() ?? ''
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : 'bin'
}

/**
 * Demo AI path: temp-file → extract text → agent → DemoResult, or an honest error.
 * Never throws; always cleans up the temp file. Returns exactly one of { result }
 * or { error } (a user-facing message). The live extract/agent run only in the
 * backend image (poppler / libreoffice / tesseract + agent binary + DeepSeek env).
 */
export async function runDemoAiExtract(
  bytes: Uint8Array,
  fileName: string,
  deps: DemoAiDeps
): Promise<{ result?: DemoResult, error?: string }> {
  let path = ''
  try {
    path = await deps.writeTemp(bytes, extOf(fileName))
    const text = await deps.extractText(path, fileName)
    if (!text || !text.trim()) {
      return { error: 'Не удалось извлечь текст из документа (возможно, это пустой или нечитаемый скан).' }
    }
    const out = await deps.runAgent(text)
    if (!out.ok || !out.document) {
      return { error: out.error || 'AI не смог разобрать документ. Попробуйте другой файл.' }
    }
    if (!out.document.items?.length) {
      return { error: 'В документе не найдена табличная часть (товары).' }
    }
    return { result: extractedToDemoResult(out.document) }
  } catch {
    return { error: 'Ошибка обработки документа.' }
  } finally {
    if (path) await deps.cleanup(path).catch(() => {})
  }
}
