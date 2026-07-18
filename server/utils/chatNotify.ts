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

/** Build the success chat message (BB-safe). External fields are neutralised. */
export function buildSuccessMessage(s: SuccessSummary): string {
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
  lines.push(entityLink(s.entityTypeId, s.entityId))
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
