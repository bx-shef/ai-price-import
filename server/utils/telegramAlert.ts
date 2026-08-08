import type { FetchFn } from './b24Rest'

// Outbound alert channel — Telegram (BACKLOG.md §1 «Алертинг очередей»).
//
// Until now a queue alert only went to the server log and the `/queues` page: both require somebody
// to already be looking, which is exactly what an alert is for. Telegram is the first channel that
// pushes.
//
// This is OUR infrastructure talking to US. It is deliberately NOT the per-portal error chat: a
// stalled queue is our outage, not the tenant's, and telling a client's admin about our Redis would
// be both useless to them and a leak of how the service is run.
//
// SECURITY: the bot token is a bearer credential that sits in the URL of every call. It is never
// logged, never put in an error message, and never returned to a caller — only the numeric status
// is surfaced. Same rule as the GitHub feedback token.

export interface TelegramConfig {
  token: string
  /** Group/channel id. Groups are negative («-100…»), a private chat is a positive user id. */
  chatId: string
}

/** Bot tokens look like `<digits>:<base64ish>` — a shape check catches a truncated paste. */
const TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{20,}$/
/** A chat id is an integer, optionally negative; `@channelname` is also accepted by Telegram. */
const CHAT_RE = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/

/**
 * Resolve the channel from env, or `null` when it is off.
 *
 * Fail-closed and SILENT about why beyond a shape verdict: an unset channel is a normal deployment
 * (dev, a portal-less build), not an error. Both parts are required — a token with no chat id has
 * nowhere to send, and half-configured would otherwise look enabled and drop every alert.
 *
 * ⚠ Имена переменных — ПАРАМЕТР, а не литерал внутри (#466): каналов теперь два — тревоги и
 * еженедельная сводка по отзывам, — и жить им положено в РАЗНЫХ чатах (решение владельца
 * 08.08.2026). Проверки формы при этом общие: скопировать их значило бы однажды получить две
 * разошедшиеся редакции, из которых одна молча пропускает обрезанный токен.
 */
export function resolveTelegramConfig(
  env: Record<string, string | undefined> = process.env,
  names: { token: string, chatId: string } = { token: 'TELEGRAM_ALERT_BOT_TOKEN', chatId: 'TELEGRAM_ALERT_CHAT_ID' }
): TelegramConfig | null {
  const token = (env[names.token] ?? '').trim()
  const chatId = (env[names.chatId] ?? '').trim()
  if (!TOKEN_RE.test(token) || !CHAT_RE.test(chatId)) return null
  return { token, chatId }
}

export interface TelegramSendResult {
  ok: boolean
  status: number
  /** Could a later attempt plausibly succeed? 429/5xx/network yes; 400/401/403 no. */
  retryable: boolean
}

/** Telegram caps a message at 4096 characters. */
export const MAX_TELEGRAM_TEXT = 4096

/**
 * Hard bound on one send.
 *
 * Without it the call inherits undici's 300-second header timeout, and the caller — which sends
 * sequentially — could sit for tens of minutes. Worse, an outgoing HTTP call hanging is CORRELATED
 * with the outage being reported (a host network problem breaks both), so exactly when the alert
 * matters most the channel would be at its slowest. Ten seconds is far more than a healthy
 * `sendMessage` needs.
 */
export const TELEGRAM_TIMEOUT_MS = 10_000

/**
 * Send one message.
 *
 * `parse_mode` is deliberately NOT set: plain text means there is no markup for anything in the
 * message to escape out of. Our alert text is built from queue names and numbers today, but the
 * cost of that guarantee is zero and it survives someone later interpolating a portal-supplied
 * string in here.
 */
export async function sendTelegramAlert(config: TelegramConfig, text: string, fetchFn: FetchFn): Promise<TelegramSendResult> {
  const body = JSON.stringify({
    chat_id: config.chatId,
    text: text.slice(0, MAX_TELEGRAM_TEXT),
    disable_web_page_preview: true
  })
  let res: Awaited<ReturnType<FetchFn>>
  try {
    res = await fetchFn(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS)
    })
  } catch {
    // Never include the error: it can echo the request URL, and the URL carries the token.
    return { ok: false, status: 0, retryable: true }
  }
  const status = res.status
  return { ok: status === 200, status, retryable: status === 429 || status >= 500 }
}
