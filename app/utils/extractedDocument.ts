import type { DocumentItem, DocumentParty, ExtractedDocument, TaxIdKind } from '~/types/document'

// Normalise the agent's RAW JSON output into a safe ExtractedDocument. The LLM
// output is untrusted (shape and types can drift or be adversarial via the source
// document) → coerce/clamp everything, drop unusable rows, bound sizes (DoS).
// Pure, no I/O. docs/redesign 02 §«Решения по проводке crm-sync».

/** Hard ceiling on product rows from one document. A DoS guard against a
 * runaway/hostile table — NOT a silent truncation point: the caller (runAgent)
 * treats a raw item count above this as a hard error (no partial import), so real
 * documents up to this size import 1-в-1 and anything larger fails loudly. */
export const MAX_ITEMS = 10_000
const MAX_STR = 500
const MAX_TAXID_DIGITS = 24
const TAX_ID_KINDS: readonly TaxIdKind[] = ['INN', 'UNP', 'BIN', 'IIN']

function str(v: unknown, max = MAX_STR): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t ? t.slice(0, max) : undefined
}

/**
 * Coerce a printed number to a finite value, or undefined. Handles ru/be/kk forms:
 * whitespace/NBSP thousands ("1 234,56"), comma decimal, dot decimal, both-separator
 * ("1.234.567,89" / "1,234.56"), dot- or comma-grouped thousands ("1.234.567"), and
 * a trailing percent ("20%" → 20). Ambiguous single-separator cases resolve toward
 * the DECIMAL reading (ru/be/kk convention: comma is the decimal point).
 */
function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v !== 'string') return undefined
  let s = v.replace(/\s/g, '').replace(/%/g, '').replace(/[₽$€]/g, '')
  if (!s) return undefined // "" / whitespace-only → undefined (so a default like ?? 1 applies)
  const dots = (s.match(/\./g) || []).length
  const commas = (s.match(/,/g) || []).length
  if (commas && dots) {
    // Both present: the LAST separator is the decimal; the other groups thousands.
    s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '')
  } else if (commas > 1) {
    s = s.replace(/,/g, '') // 1,234,567 → thousands grouping
  } else if (commas === 1) {
    s = s.replace(',', '.') // decimal comma
  } else if (dots > 1) {
    s = s.replace(/\./g, '') // 1.234.567 → thousands grouping
  } // single dot, no comma → left as the decimal point
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
  const price = num(o.price)
  const quantity = num(o.quantity)
  // A row with no name but real numbers is a genuine line whose name failed
  // extraction — keep it under a placeholder so the total stays 1-в-1 rather than
  // silently vanish. Only a row with neither a name nor any number is noise → drop.
  if (!name && price === undefined && quantity === undefined) return null
  const item: DocumentItem = {
    name: name ?? '(позиция без наименования)',
    price: price ?? 0,
    quantity: quantity ?? 1
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
  // currency: ISO 4217 → letters only, uppercased, EXACTLY 3 (reject "USDT"/junk;
  // do NOT truncate 4+ letters to 3, which would silently accept a wrong code).
  const cur = (str(o.currency) ?? '').replace(/[^a-zA-Z]/g, '').toUpperCase()
  if (cur.length === 3) doc.currency = cur
  if (typeof o.priceIncludesVat === 'boolean') doc.priceIncludesVat = o.priceIncludesVat
  const supplier = normaliseSupplier(o.supplier)
  if (supplier) doc.supplier = supplier
  return doc
}
