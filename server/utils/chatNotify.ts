import type { RestCall } from './b24Rest'
import { portalHost } from '~/config/b24'
import { buildBotSend, buildChatJoin, errorCode, messageIdFromBotSend } from './chatBot'

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

/**
 * Build a clickable BB-code link to the created entity for the chat message.
 *
 * B24 messenger renders `[URL=…]текст[/URL]`; a bare path is NOT a link (owner ask). The address is
 * absolute and built from the PORTAL's host — reliable across web, desktop and mobile clients.
 *
 * ⚠ Host unknown ⇒ NO link, only the text. The previous fallback emitted a portal-RELATIVE
 * `[URL=/crm/…]`, defended as «can't leave the portal» — but the question is not where it leads,
 * it is whether it leads anywhere: in the desktop and mobile clients a relative URL has no base and
 * the link is simply dead. The same rule as the failure notice (#385): a dead link promises a way
 * somewhere and delivers nothing, which is worse than no link at all.
 */
export function entityChatLink(entityTypeId: number, id: number, portalDomain?: string): string | null {
  const host = portalHost(portalDomain)
  return host ? `[URL=https://${host}${entityLink(entityTypeId, id)}]Открыть в CRM[/URL]` : null
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
  /** Подсказка «что делать с пропущенными строками». Не проблема и не входит в счётчик (#388). */
  advice?: string
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
  // Совет — ПОСЛЕ списка и ВНЕ его обрезки (#388). В списке он раздувал счётчик и читался как ещё
  // одна поломка; в хвосте обрезаемого списка он терялся тем вернее, чем больше строк пропущено.
  if (s.advice) lines.push(chatSafeText(s.advice, MAX_CHAT_REASON))
  // No host ⇒ the line is dropped, not degraded: «Открыть в CRM» that opens nothing reads as a
  // broken app, while its absence just means the message is shorter.
  const link = entityChatLink(s.entityTypeId, s.entityId, portalDomain)
  if (link) lines.push(link)
  return lines.join('\n')
}

/** Build the error chat message (BB-safe). */
export function buildErrorMessage(supplierName: string | undefined, messages: string[]): string {
  const who = (supplierName ? chatSafeText(supplierName, MAX_CHAT_FILE_NAME) : '') || 'документ'
  const lines = [`⛔ Импорт не выполнен: ${who}`]
  for (const m of messages.slice(0, 20)) lines.push(`• ${chatSafeText(m, MAX_CHAT_REASON)}`)
  return lines.join('\n')
}

/**
 * Send one chat message. URL_PREVIEW off (avoid rich-link noise).
 *
 * With a `botId` the message goes AS THE APP (#316, `imbot.v2.Chat.Message.send`). Without one — or
 * when the bot call is refused — it falls back to `im.message.add`, which writes as the owner of
 * the token. That fallback is deliberate and must stay: a portal on a free plan, at its bot limit,
 * or installed before the `imbot` scope existed has no bot, and for those the choice is «wrong
 * author» versus «no message at all». The failure notice is the only channel that reaches the
 * employee who uploaded the document (#288), so silence is the worse half of that trade.
 */
export async function sendChatMessage(
  dialogId: string,
  message: string,
  call: RestCall,
  botId?: number | null,
  log?: (msg: string) => void
): Promise<number | null> {
  const text = message.trim()
  if (!dialogId || !text) return null
  const bot = botId && botId > 0 ? buildBotSend(botId, dialogId, text) : null
  if (bot) {
    let answered = false
    try {
      const res = await call(bot.method, bot.params)
      answered = true
      const id = messageIdFromBotSend(res)
      if (id) return id
    } catch (e) {
      // Code only: the rejected call carries the message text, and a REST error can echo it.
      log?.(`[chat-bot] send refused: ${errorCode(e)}`)
      // A bot may only post in a chat it belongs to, and nothing ever added it — which is exactly
      // how this feature failed live: every notice was refused and fell back, signed by the
      // employee. So a refusal buys ONE join + ONE retry before giving up on the bot path.
      //
      // Reactive rather than proactive on purpose: checking membership before every message would
      // cost a REST call per notice forever, to fix something that is wrong once per chat.
      const join = buildChatJoin(dialogId, botId!)
      if (join) {
        try {
          await call(join.method, join.params)
          const res = await call(bot.method, bot.params)
          answered = true
          const id = messageIdFromBotSend(res)
          if (id) return id
        } catch (e2) {
          log?.(`[chat-bot] join+retry refused: ${errorCode(e2)}`)
        }
      }
    }
    // ⚠ Fall back ONLY when the call THREW. A call that answered with a shape we do not recognise
    // most likely DELIVERED the message — resending it through im.message.add would post the same
    // notice twice, in the very chat this feature exists to keep readable. An unknown envelope is
    // reported as «sent, id unknown» (null), which no caller treats as an error.
    if (answered) {
      log?.('[chat-bot] sent, but the response carried no message id')
      return null
    }
  }
  const res = await call('im.message.add', { DIALOG_ID: dialogId, MESSAGE: text, URL_PREVIEW: 'N' })
  const id = Number(res)
  return Number.isFinite(id) && id > 0 ? id : null
}
