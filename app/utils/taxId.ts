import type { TaxIdKind } from '~/types/document'

/** Digits-only length expected per tax-id kind (see 06-multilingual.md §2). */
const TAX_ID_LENGTHS: Record<TaxIdKind, number[]> = {
  INN: [10, 12], // RU: юр. 10 / физ.-ИП 12
  UNP: [9], // BY: 9
  BIN: [12], // KZ: юр. 12
  IIN: [12] // KZ: физ. 12
}

/** Strip everything but digits — the value used for RQ_INN search. */
export function normalizeTaxId(raw: string): string {
  return (raw ?? '').replace(/\D+/g, '')
}

/** Loose validity check by kind (length of digits). Unknown kind → any non-empty. */
export function isPlausibleTaxId(digits: string, kind?: TaxIdKind): boolean {
  if (!digits) return false
  if (!kind) return digits.length >= 8 && digits.length <= 12
  return TAX_ID_LENGTHS[kind].includes(digits.length)
}
