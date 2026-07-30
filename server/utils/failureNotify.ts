// Pure decision core for «документ не удалось внести» notifications (BACKLOG.md §1).
//
// Everything that decides WHO is written to and WHAT the text says lives here, so it can be tested;
// liveDeps keeps only the I/O (claim → read → resolve transport → send). The previous version put
// this logic inline in the wiring, where a review found five silent mutations — including one that
// double-posted the crm-sync failure into the error chat.

// `chatSafeText` and the caps live in chatNotify.ts — the same guard has to cover the crm-sync
// success/error messages too, and two copies of a sanitiser drift.
import { MAX_CHAT_FILE_NAME, MAX_CHAT_REASON, chatSafeText } from './chatNotify'

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

  if (input.alsoErrorChat && input.errorChatId) {
    const lines = [`⛔ Импорт не удался: «${name}».`]
    if (why) lines.push(why)
    // The id is anonymous — it identifies the import, not the person, and without it the admin has
    // nothing to look the failure up by (there is no server-side list of jobs).
    lines.push(`Задание: ${chatSafeText(input.jobId, 64)}`)
    out.push({ dialogId: input.errorChatId, message: lines.join('\n') })
  }

  return out
}
