import type { DocumentItem, DocumentParty, ExtractedDocument, TaxIdKind } from '~/types/document'

// Normalise the agent's RAW JSON output into a safe ExtractedDocument. The LLM
// output is untrusted (shape and types can drift or be adversarial via the source
// document) → coerce/clamp everything, drop unusable rows, bound sizes (DoS).
// Pure, no I/O. docs/redesign 02 §«Решения по проводке crm-sync».

/** Max product rows we accept from one document (guards a runaway/hostile table). */
export const MAX_ITEMS = 2000
const MAX_STR = 500
const MAX_TAXID_DIGITS = 24
const TAX_ID_KINDS: readonly TaxIdKind[] = ['INN', 'UNP', 'BIN', 'IIN']

function str(v: unknown, max = MAX_STR): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t ? t.slice(0, max) : undefined
}

/** Coerce to a finite number (accepts "1 234,56" / "1,234.56" style strings). */
function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v !== 'string') return undefined
  // Strip whitespace thousands-separators (JS \s covers NBSP/narrow-NBSP), then
  // reconcile comma vs dot as the decimal separator.
  let s = v.replace(/\s/g, '')
  if (s.includes(',') && s.includes('.')) {
    // Last separator is the decimal one; the other groups thousands.
    s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '')
  } else if (s.includes(',')) {
    s = s.replace(',', '.')
  }
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

function taxIdKind(v: unknown): TaxIdKind | undefined {
  const t = typeof v === 'string' ? v.trim().toUpperCase() : ''
  return (TAX_ID_KINDS as readonly string[]).includes(t) ? t as TaxIdKind : undefined
}

function normaliseSupplier(v: unknown): DocumentParty | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const name = str(o.name)
  if (!name) return undefined
  const party: DocumentParty = { name }
  // taxId: keep digits only (RQ_INN search value); country-agnostic.
  const digits = (str(o.taxId) ?? '').replace(/\D/g, '').slice(0, MAX_TAXID_DIGITS)
  if (digits) {
    party.taxId = digits
    const kind = taxIdKind(o.taxIdKind)
    if (kind) party.taxIdKind = kind
  }
  return party
}

function normaliseItem(v: unknown): DocumentItem | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const name = str(o.name)
  if (!name) return null // a row with no name is unusable
  const item: DocumentItem = {
    name,
    price: num(o.price) ?? 0,
    quantity: num(o.quantity) ?? 1
  }
  const article = str(o.article)
  if (article) item.article = article
  const unit = str(o.unit, 64)
  if (unit) item.unit = unit
  const vatRate = num(o.vatRate)
  if (vatRate !== undefined) item.vatRate = vatRate
  return item
}

/**
 * Validate + normalise raw agent JSON → ExtractedDocument, or null when there is
 * no usable tabular part (no valid item rows). Never throws.
 */
export function validateExtractedDocument(raw: unknown): ExtractedDocument | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const rawItems = Array.isArray(o.items) ? o.items : []
  const items: DocumentItem[] = []
  for (const r of rawItems) {
    const it = normaliseItem(r)
    if (it) items.push(it)
    if (items.length >= MAX_ITEMS) break
  }
  if (!items.length) return null

  const doc: ExtractedDocument = { items }
  const documentType = str(o.documentType, 120)
  if (documentType) doc.documentType = documentType
  // currency: ISO 4217-ish → letters only, uppercased, ≤ 3 (BYN/RUB/USD/KZT).
  const cur = (str(o.currency) ?? '').replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 3)
  if (cur.length === 3) doc.currency = cur
  if (typeof o.priceIncludesVat === 'boolean') doc.priceIncludesVat = o.priceIncludesVat
  const supplier = normaliseSupplier(o.supplier)
  if (supplier) doc.supplier = supplier
  return doc
}
