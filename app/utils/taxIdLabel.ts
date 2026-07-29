// User-facing wording for the counterparty's tax id. Two problems it solves (#264):
//
// 1. Messages listed «ИНН/УНП/БИН» because no single short term covers RU/BY/KZ — each country has
//    its own (Bitrix24 itself stores them all in ONE field, RQ_INN). We already extract WHICH label
//    the number was printed under (`taxIdKind`), it just was not used in any text. Naming the actual
//    label makes the listing unnecessary.
// 2. One message covered two different situations — «number found, company missing» and «no number in
//    the document at all» — and told the reader to create a company even when there was nothing to
//    search by.
//
// Printing the number is safe: taxId is normalised to digits with a length cap on extraction, and all
// warnings are BB-neutralised before they reach the timeline entry and the chat. It must NOT be added
// to telemetry attributes — those go through an allowlist.

import type { TaxIdKind } from '~/types/document'

const LABELS: Record<TaxIdKind, string> = {
  INN: 'ИНН',
  UNP: 'УНП',
  BIN: 'БИН', // Russian-language form of the Kazakh «БСН»
  IIN: 'ИИН'
}

/** «УНП» when the printed label was recognised, else the generic «налоговый номер». */
export function taxIdLabel(kind: TaxIdKind | undefined): string {
  return (kind && LABELS[kind]) || 'налоговый номер'
}

/** Same thing in the case the phrase «не найден по …» requires — abbreviations don't decline,
 *  the generic wording does («по УНП 123» / «по налоговому номеру 123»). */
export function taxIdLabelBy(kind: TaxIdKind | undefined): string {
  return (kind && LABELS[kind]) || 'налоговому номеру'
}

/**
 * Warning for a document whose supplier was not linked to a CRM company. Splits the two cases so the
 * suggested action is actually the one that helps.
 */
export function supplierNotLinkedWarning(taxId: string | undefined, kind: TaxIdKind | undefined): string {
  if (!taxId) {
    return 'В документе не распознан налоговый номер поставщика, поэтому искать компанию не по чему — '
      + 'запись создана без привязки к компании. Проверьте, что номер напечатан в документе.'
  }
  return `Поставщик не найден в CRM по ${taxIdLabelBy(kind)} ${taxId} — запись создана без привязки к компании. `
    + 'Заведите компанию с этим номером, и следующий импорт привяжется сам.'
}
