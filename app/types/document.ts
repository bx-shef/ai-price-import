// Domain model of a parsed source document with a tabular part.
// Language-agnostic (see docs/redesign/06-multilingual.md): the agent fills this
// from a document in ru/be/kk. Pure data — no I/O.

/** Tax-id label kinds recognised across countries. */
export type TaxIdKind = 'INN' | 'UNP' | 'BIN' | 'IIN'

/** A recognised counterparty (supplier) from the document. */
export interface DocumentParty {
  /** Raw name as printed in the document. */
  name: string
  /** Normalised tax id digits (RQ_INN search value), if recognised. */
  taxId?: string
  /** Which label the tax id was printed under. */
  taxIdKind?: TaxIdKind
}

/** A single product line (tabular part row). */
export interface DocumentItem {
  /** Product name as printed. */
  name: string
  /** Supplier article/vendor code as printed, if any. */
  article?: string
  /** Quantity (finite, > 0 expected; caller clamps). */
  quantity: number
  /** Unit of measure as printed (e.g. "шт", "кг", "дана"). */
  unit?: string
  /** Price per unit as printed. */
  price: number
  /** VAT rate percent as printed (e.g. 0, 20, 22), if any. */
  vatRate?: number
}

/** The whole extracted document. */
export interface ExtractedDocument {
  /** Classified document type (agent), e.g. "накладная" | "счёт" | "КП". */
  documentType?: string
  /** ISO 4217 currency code as printed, e.g. "BYN", "RUB". */
  currency?: string
  /** Whether prices include VAT — must be uniform across the document. */
  priceIncludesVat?: boolean
  supplier?: DocumentParty
  items: DocumentItem[]
}
