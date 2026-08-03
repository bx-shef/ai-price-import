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
import { stripHostileChars } from '~/utils/feedback'

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
 * Cap on the counterparty name inside the warning.
 *
 * ⚠ The name comes from the DOCUMENT, i.e. from whoever uploaded the file. Injection is already
 * handled (warnings are BB-neutralised before the timeline entry and the chat, and telemetry takes
 * only allowlisted attributes), but the new text adds a property the old one did not have: LENGTH.
 * Names in real documents carry the full legal form and sometimes the address, and one such warning
 * would stretch both the chat message and the дело card.
 */
export const MAX_COUNTERPARTY_NAME = 60

/**
 * Name from the document, made safe to print.
 *
 * ⚠ Cut by CODE POINTS, not by UTF-16 units. `slice(0, 60)` splits a surrogate pair, and the lone
 * half travels all three paths as is: the chat and the дело show «», and a portal that rejects the
 * malformed JSON drops the best-effort message entirely — precisely on the long foreign name the
 * cap exists for. Measured on «А»×59 + an emoji.
 *
 * ⚠ Hostile invisibles are stripped too (`stripHostileChars`: bidi overrides, zero-widths, C0).
 * BB-neutralisation covers markup, but a right-to-left override reverses how the name READS in the
 * chat, in the timeline card and on screen — the module header used to call injection «already
 * handled», which was true for BB and false for these.
 */
export function capName(name: string | undefined): string {
  const clean = stripHostileChars(name ?? '').replace(/\s+/g, ' ').trim()
  return [...clean].slice(0, MAX_COUNTERPARTY_NAME).join('')
}

/**
 * Warning for a document whose counterparty was not linked to a CRM company. Splits the two cases so
 * the suggested action is actually the one that helps.
 *
 * Wording decisions, recorded because each of them looks like a regression to the next reader (#384):
 *
 * • **The name is printed.** «Контрагент не найден» without one made the reader open the document to
 *   see WHICH one — and a batch of invoices produces a batch of identical warnings.
 * • **The printed label (УНП/ИНН/БИН) is gone** from this sentence — the number stands in brackets
 *   after the name, where a label reads as clutter. This is NOT a loss of #264: that issue was about
 *   not listing all three abbreviations at once, and nothing lists them now either. The label still
 *   names the number in the «имя не распозналось» branch below.
 * • **The consequence stays**, as a short second sentence. The owner's draft dropped it, but this is
 *   the ONLY place a person is told that the entity was nevertheless created and is hanging without
 *   a company; «не найден» alone reads as «ничего не произошло».
 * • **«Поставщик» → «контрагент»** everywhere, including the metrics counter — otherwise the product
 *   calls one thing by two words in two screens.
 */
export function supplierNotLinkedWarning(
  taxId: string | undefined,
  kind: TaxIdKind | undefined,
  name?: string
): string {
  if (!taxId) {
    return 'В документе не распознан налоговый номер контрагента, поэтому искать компанию не по чему — '
      + 'запись создана без привязки к компании. Проверьте, что номер напечатан в документе.'
  }
  // Имени может не быть (распозналось не всё) — тогда «Контрагент  (123) не найден» с дырой
  // посередине; в этом случае называем номер тем ярлыком, под которым он напечатан.
  const clean = capName(name)
  const who = clean ? `Контрагент ${clean} (${taxId})` : `Контрагент по ${taxIdLabelBy(kind)} ${taxId}`
  return `${who} не найден — запись создана без привязки к компании. `
    + 'Заведите компанию с этим номером налогоплательщика в реквизитах, и следующий импорт привяжется сам.'
}
