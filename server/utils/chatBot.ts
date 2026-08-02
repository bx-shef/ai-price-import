import type { RestCall } from './b24Rest'

/**
 * Chat messages sent AS THE APP, not as the employee whose OAuth token we happen to hold (#316).
 *
 * `im.message.add` writes as the token owner — there is no other behaviour — so import reports and
 * failure notices read as if a colleague were posting them into a shared chat. The failure notice
 * is the worst case: it arrives in the uploader's own personal chat, i.e. from themselves.
 *
 * The fix is a registered chat bot. Facts checked against the REST reference (2026-08-02), because
 * this corner of the API has two live generations:
 *   • `imbot.register` and `imbot.message.add` are DEPRECATED — do not use them in new code;
 *   • the current pair is `imbot.v2.Bot.register` + `imbot.v2.Chat.Message.send`, scope `imbot`;
 *   • registration is IDEMPOTENT by `code` — a repeat call returns the existing bot and overwrites
 *     nothing, so it needs no dedup of our own;
 *   • `botToken` is for webhooks only; under OAuth it must not be sent;
 *   • `eventMode: 'fetch'` (the default) suits a send-only bot — no webhook URL to expose.
 *
 * ⚠ NOT live-verified: no test portal was reachable when this was written. Two documented errors
 * decide whether it works at all on a given portal — `ACCESS_DENIED` («REST API is available only
 * on commercial plans») and `BOT_LIMIT_EXCEEDED` — which is exactly why every caller keeps the old
 * `im.message.add` path as a fallback. Silence is not an option: the failure notice is the only
 * channel that reaches the employee (#288).
 */

/** Bot code — unique within the app, and the idempotency key of the registration call. */
export const BOT_CODE = 'ai-price-import'

/** The bot's face in the chat. `workPosition` shows under the name in Bitrix24. */
export const BOT_PROPERTIES = {
  name: 'AI-импорт прайсов',
  workPosition: 'Импорт документов в CRM'
} as const

export interface RestRequest { method: string, params: Record<string, unknown> }

/** Registration call. Idempotent by `code`; no `botToken` (OAuth context). */
export function buildBotRegister(): RestRequest {
  return {
    method: 'imbot.v2.Bot.register',
    params: {
      fields: {
        code: BOT_CODE,
        properties: { ...BOT_PROPERTIES },
        type: 'bot',
        eventMode: 'fetch'
      }
    }
  }
}

/** Bot id out of the registration envelope (`result.bot.id`), or null if the shape is unexpected. */
export function botIdFromRegister(res: unknown): number | null {
  const bot = (res as { bot?: { id?: unknown } } | null)?.bot
  const id = Number(bot?.id)
  return Number.isFinite(id) && id > 0 ? id : null
}

/**
 * One message from the bot. `dialogId` is the SAME identifier the settings already store
 * (`chat123` for a group chat, a bare user id for a personal one) — no migration of stored values.
 * `urlPreview: false` mirrors `URL_PREVIEW: 'N'` of the old path: link cards are noise here, and an
 * external string that survived neutralisation must not gain a rich preview.
 */
export function buildBotSend(botId: number, dialogId: string, message: string): RestRequest | null {
  const text = message.trim()
  if (!(botId > 0) || !dialogId || !text) return null
  return {
    method: 'imbot.v2.Chat.Message.send',
    params: { botId, dialogId, fields: { message: text, urlPreview: false } }
  }
}

/** Message id out of the send envelope (`result.id`). */
export function messageIdFromBotSend(res: unknown): number | null {
  const id = Number((res as { id?: unknown } | null)?.id)
  return Number.isFinite(id) && id > 0 ? id : null
}

/**
 * Register the bot for this portal, returning its id.
 *
 * Errors are swallowed into `null` ON PURPOSE: a portal on a free plan, at its bot limit, or
 * installed before the `imbot` scope existed simply has no bot — and a chat notice that never
 * arrives is a worse outcome than one signed by the wrong author. The caller falls back.
 */
export async function registerBot(call: RestCall, log?: (msg: string) => void): Promise<number | null> {
  const req = buildBotRegister()
  try {
    return botIdFromRegister(await call(req.method, req.params))
  } catch (e) {
    // Error CLASS only — the portal's text may quote its own internals.
    log?.(`[chat-bot] registration refused: ${(e as Error)?.message?.slice(0, 120) ?? 'unknown'}`)
    return null
  }
}
