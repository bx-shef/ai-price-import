import type { RestCall } from './b24Rest'

// Chat notifications for crm-sync (im.message.add — scope `im`, live-verified).
// Success → mapping.notifyChatId, hard errors → mapping.errorChatId.
// SECURITY: supplier name / document text is attacker-controlled (the uploader picks
// them), so any external string is BB-neutralised before it reaches a chat — otherwise
// `[url=…]` / mentions / keyboard-buttons could be injected. Same guard as the sibling
// client-bank app.

const ENTITY_PATHS: Record<number, (id: number) => string> = {
  1: id => `/crm/lead/details/${id}/`, // #135
  2: id => `/crm/deal/details/${id}/`,
  7: id => `/crm/quote/show/${id}/`
}

/** Portal path to open a created CRM entity (deal/quote/smart-*). */
export function entityLink(entityTypeId: number, id: number): string {
  const fn = ENTITY_PATHS[entityTypeId]
  return fn ? fn(id) : `/crm/type/${entityTypeId}/details/${id}/`
}

/** Build a clickable BB-code link to the created entity for the chat message. B24 messenger
 *  renders `[URL=…]текст[/URL]`; a bare path is NOT a link (owner ask). An absolute
 *  `https://<host>/…` is used when the portal host is known (reliable across web/desktop/mobile
 *  clients); with no host we fall back to the portal-relative path (still safe — can't leave the
 *  portal). `portalDomain` is a host or a full URL; the scheme/path are normalised off. */
export function entityChatLink(entityTypeId: number, id: number, portalDomain?: string): string {
  const path = entityLink(entityTypeId, id)
  const host = (portalDomain ?? '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim().toLowerCase()
  const url = host ? `https://${host}${path}` : path
  return `[URL=${url}]Открыть в CRM[/URL]`
}

/** Neutralise BB-code brackets in external text (fullwidth) so it can't inject markup. */
export function neutralizeBb(text: string): string {
  return String(text ?? '').replace(/\[/g, '［').replace(/\]/g, '］')
}

/** Cap on a file/supplier name inside a chat message. Names come from the upload, unbounded. */
export const MAX_CHAT_FILE_NAME = 80
/** Cap on a reason/warning line. It can quote the portal; a wall of text helps nobody. */
export const MAX_CHAT_REASON = 200

/**
 * The ONE place external text is made safe for a Bitrix24 chat message.
 *
 * Every string here is chosen by somebody else — a file name is whatever the uploader saved the
 * file as, a supplier name and a warning come out of the uploaded document. Four hazards, and
 * `neutralizeBb` alone covers only the first:
 *
 *  1. **BB-разметка** — folded brackets kill `[URL=]`, `[USER=]`, `[SEND=]` and the rest.
 *  2. **Голая ссылка** — messengers linkify `https://…` and `www.` with no markup at all. A
 *     document whose supplier is «оплатите тут https://…» made the app itself the sender of a
 *     phishing link in the admin's chat, which reads far more trustworthy than the same text from a
 *     colleague. The scheme's colon and the `www` dot become look-alikes: readable, not a link.
 *  3. **Переводы строк** — Bitrix24 renders a leading `>>` as a quote and a line of dashes as a
 *     divider, so injected newlines let external text fake message structure. We own the line
 *     breaks in these messages; external text gets spaces.
 *  4. **Внутренние пути** — tool stderr (`pdftotext`, `libreoffice`, `tesseract`) quotes paths that
 *     embed the portal member id and the job id. Those belong in the server log, not in a chat.
 */
export function chatSafeText(raw: unknown, max: number): string {
  return neutralizeBb(String(raw ?? ''))
    .replace(/\s+/g, ' ')
    .replace(/(^|[\s(»"'])\/[\w.-]+(?:\/[\w.-]+)+/g, '$1<путь>')
    .replace(/\bhttps?:\/\//gi, m => m.replace(':', '：'))
    .replace(/\bwww\./gi, 'www․')
    .trim()
    .slice(0, max)
}

export interface SuccessSummary {
  supplierName?: string
  entityTypeId: number
  entityId: number
  created: boolean
  rowCount: number
  warnings: string[]
}

/** Build the success chat message (BB-safe). External fields are neutralised. `portalDomain`
 *  (optional) makes the entity link an absolute clickable BB-link. */
export function buildSuccessMessage(s: SuccessSummary, portalDomain?: string): string {
  const who = (s.supplierName ? chatSafeText(s.supplierName, MAX_CHAT_FILE_NAME) : '') || 'документ'
  const head = s.created ? '✅ Импортирован документ' : 'ℹ️ Документ уже был импортирован'
  const lines = [
    `${head}: ${who}`,
    `Позиций: ${s.rowCount}`
  ]
  if (s.warnings.length) {
    lines.push(`Предупреждения (${s.warnings.length}):`)
    for (const w of s.warnings.slice(0, 10)) lines.push(`• ${chatSafeText(w, MAX_CHAT_REASON)}`)
  }
  lines.push(entityChatLink(s.entityTypeId, s.entityId, portalDomain))
  return lines.join('\n')
}

/** Build the error chat message (BB-safe). */
export function buildErrorMessage(supplierName: string | undefined, messages: string[]): string {
  const who = (supplierName ? chatSafeText(supplierName, MAX_CHAT_FILE_NAME) : '') || 'документ'
  const lines = [`⛔ Импорт не выполнен: ${who}`]
  for (const m of messages.slice(0, 20)) lines.push(`• ${chatSafeText(m, MAX_CHAT_REASON)}`)
  return lines.join('\n')
}

/** Send one chat message via im.message.add. URL_PREVIEW off (avoid rich-link noise). */
export async function sendChatMessage(dialogId: string, message: string, call: RestCall): Promise<number | null> {
  const text = message.trim()
  if (!dialogId || !text) return null
  const res = await call('im.message.add', { DIALOG_ID: dialogId, MESSAGE: text, URL_PREVIEW: 'N' })
  const id = Number(res)
  return Number.isFinite(id) && id > 0 ? id : null
}
