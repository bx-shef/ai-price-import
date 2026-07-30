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
  const who = s.supplierName ? neutralizeBb(s.supplierName) : 'документ'
  const head = s.created ? '✅ Импортирован документ' : 'ℹ️ Документ уже был импортирован'
  const lines = [
    `${head}: ${who}`,
    `Позиций: ${s.rowCount}`
  ]
  if (s.warnings.length) {
    lines.push(`Предупреждения (${s.warnings.length}):`)
    for (const w of s.warnings.slice(0, 10)) lines.push(`• ${neutralizeBb(w)}`)
  }
  lines.push(entityChatLink(s.entityTypeId, s.entityId, portalDomain))
  return lines.join('\n')
}

/** Build the error chat message (BB-safe). */
export function buildErrorMessage(supplierName: string | undefined, messages: string[]): string {
  const who = supplierName ? neutralizeBb(supplierName) : 'документ'
  const lines = [`⛔ Импорт не выполнен: ${who}`]
  for (const m of messages.slice(0, 20)) lines.push(`• ${neutralizeBb(m)}`)
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

/** Cap on the failure text sent to a person. The reason can carry a portal response; a wall of
 *  text in a personal chat is worse than a short one plus the app screen. */
export const MAX_FAILURE_REASON = 300

/**
 * Personal message to the employee whose document failed (бэклог §1 «связь с сотрудником»).
 *
 * Until now a failure was only visible in that person's own list of operations — which they see
 * only if they happen to reopen the app. The person who did the work is told directly instead.
 *
 * The file name comes from the upload and the reason can quote the portal, so BOTH are external
 * text: neutralised, and the reason is capped. Addressed by DIALOG_ID = the portal user id.
 */
export function buildUploaderFailureMessage(fileName: string, reason: string): string {
  const name = neutralizeBb(String(fileName ?? '').trim()) || 'документ'
  const why = neutralizeBb(String(reason ?? '').trim()).slice(0, MAX_FAILURE_REASON)
  const lines = [`Не удалось внести в CRM ваш документ «${name}».`]
  if (why) lines.push(why)
  lines.push('Файл можно загрузить снова в приложении «AI-импорт прайсов».')
  return lines.join('\n')
}

/**
 * Same failure, for the ERROR CHAT the admin configured — an operator reading it needs the file
 * name, since one chat carries every import of the portal. No user id: the chat is for «что
 * сломалось», and naming the employee there would put a person under a spotlight for a document
 * the app failed to read.
 */
export function buildFailureChatMessage(fileName: string, reason: string): string {
  const name = neutralizeBb(String(fileName ?? '').trim()) || 'документ'
  const why = neutralizeBb(String(reason ?? '').trim()).slice(0, MAX_FAILURE_REASON)
  return [`Импорт не удался: «${name}».`, ...(why ? [why] : [])].join('\n')
}
