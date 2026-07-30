// Pure decision core for «документ не удалось внести» notifications (BACKLOG.md §1).
//
// Everything that decides WHO is written to and WHAT the text says lives here, so it can be tested;
// liveDeps keeps only the I/O (claim → read → resolve transport → send). The previous version put
// this logic inline in the wiring, where a review found five silent mutations — including one that
// double-posted the crm-sync failure into the error chat.

import { neutralizeBb } from './chatNotify'

/** Cap on the file name inside a chat message. Names come from the upload and are unbounded. */
export const MAX_CHAT_FILE_NAME = 80
/** Cap on the reason. It can quote the portal; a wall of text in a personal chat helps nobody. */
export const MAX_CHAT_REASON = 200

/**
 * Make external text safe for a Bitrix24 chat message.
 *
 * Three separate hazards, all from strings a portal user controls (a file name is whatever they
 * saved the file as; a reason can quote the portal or a tool):
 *
 *  1. **BB-разметка** — `neutralizeBb` folds the brackets, which kills `[URL=]`, `[USER=]`,
 *     `[SEND=]` and the rest of the bracketed set.
 *  2. **Голая ссылка** — messengers linkify `https://…` and `www.` with no markup at all. A file
 *     named «Счёт №77 оплатите тут https://…» turned the app itself into the sender of a phishing
 *     link in the admin's chat, which is worse than the same text from a colleague. The scheme's
 *     colon and the `www` dot are replaced with look-alike characters: still readable, no longer a
 *     link.
 *  3. **Переводы строк** — Bitrix24 treats a line starting with `>>` as a quote and a line of
 *     dashes as a divider, so injected newlines let external text fake message structure. Collapsed
 *     to spaces; we control the line breaks in these messages ourselves.
 */
export function chatSafeText(raw: unknown, max: number): string {
  return neutralizeBb(String(raw ?? ''))
    .replace(/\s+/g, ' ')
    .replace(/\bhttps?:\/\//gi, m => m.replace(':', '：'))
    .replace(/\bwww\./gi, 'www․')
    .trim()
    .slice(0, max)
}

/** Prefixes of reasons that carry tool output rather than an explanation for a human. */
const TECHNICAL_PREFIX = 'извлечение текста:'

/**
 * The reason as a PERSON should read it.
 *
 * Extraction failures carry raw stderr from `pdftotext` / `libreoffice` / `tesseract`: internal
 * paths (which embed the portal and job ids, and sometimes a spreadsheet's sheet name), font
 * warnings, exit codes. That belongs in the job status and the server log, not in somebody's
 * personal chat. Everything else in this app's reasons is already written for a human, so it passes
 * through untouched.
 */
export function humaniseFailureReason(reason: string): string {
  const r = String(reason ?? '').trim()
  if (!r) return ''
  if (r.toLowerCase().startsWith(TECHNICAL_PREFIX)) {
    return 'Не удалось прочитать файл — возможно, он повреждён или это снимок плохого качества.'
  }
  return r
}

export interface PlannedMessage {
  /** `im.message.add` DIALOG_ID: a bare user id (personal chat) or a `chatNNN` id. */
  dialogId: string
  message: string
}

export interface FailureNotifyInput {
  /** False when this job's failure was already announced — nothing is planned. */
  claimed: boolean
  /** Who uploaded it; null when the portal never reported an id (older jobs, odd profiles). */
  uploaderId: string | null
  fileName: string
  reason: string
  /** Admin's error chat, when configured. */
  errorChatId: string | null
  /** False on the one path that posts its own error-chat message (crm-sync hard errors). */
  alsoErrorChat: boolean
  /** True when the error chat already had a message recently — see the throttle in liveDeps. */
  errorChatThrottled?: boolean
  /** Job id — the admin's only handle for correlating a failure; there is no server-side job list. */
  jobId: string
  /** Absolute app URL, when known, so the person can get back without hunting for the app. */
  appUrl?: string | null
}

/** App name as it appears in the Bitrix24 Market card — the message must say who is writing. */
export const APP_NAME = 'AI-импорт прайсов'

/**
 * What to send, to whom. Returns an empty list when there is nothing to say.
 *
 * The two messages differ on purpose: the employee gets an apology and a way back; the error chat
 * gets a fact and a handle to look it up (owner's decision — the chat answers «что сломалось», not
 * «кто», so the employee is never named there).
 */
export function planFailureNotify(input: FailureNotifyInput): PlannedMessage[] {
  if (!input.claimed) return []
  const name = chatSafeText(input.fileName, MAX_CHAT_FILE_NAME) || 'документ'
  const why = chatSafeText(humaniseFailureReason(input.reason), MAX_CHAT_REASON)
  const out: PlannedMessage[] = []

  if (input.uploaderId) {
    const lines = [`⛔ ${APP_NAME}: не удалось внести в CRM документ «${name}».`]
    if (why) lines.push(why)
    lines.push(input.appUrl
      ? `Можно поправить и загрузить снова: [URL=${input.appUrl}]открыть приложение[/URL]`
      : 'Файл можно загрузить снова в приложении.')
    out.push({ dialogId: input.uploaderId, message: lines.join('\n') })
  }

  if (input.alsoErrorChat && input.errorChatId && !input.errorChatThrottled) {
    const lines = [`⛔ Импорт не удался: «${name}».`]
    if (why) lines.push(why)
    // The id is anonymous — it identifies the import, not the person, and without it the admin has
    // nothing to look the failure up by (there is no server-side list of jobs).
    lines.push(`Задание: ${chatSafeText(input.jobId, 64)}`)
    out.push({ dialogId: input.errorChatId, message: lines.join('\n') })
  }

  return out
}
