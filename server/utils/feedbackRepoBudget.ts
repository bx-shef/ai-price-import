import { connectionOptions } from '../queue/connection'
import { createSharedLimiter, type WindowCounterStore } from './sharedRateLimit'
import { windowCounterStore } from './windowCounterRedis'

// Global hourly ceiling on the feedback RECEIVER (#354).
//
// The per-employee limiter stops one person looping. It cannot stop the sum: the app is
// multi-tenant, employees of different portals are independent, and every review is «issue + a
// commit of up to 5 MB» under ONE publisher token. A hundred installed portals with a couple of
// active people each is already hundreds of content operations an hour; GitHub's secondary limits
// (≈500/hour on content) would then be hit by ALL tenants at once — the channel breaks not for
// whoever was noisy but for everybody.
//
// ⚠ Exhaustion behaves DIFFERENTLY from the per-person limits, and that difference is the point:
// the review is still ACCEPTED, only without its attachment. The text of a review is worth more
// than the file, and refusing the review outright would lose the report itself. Dropping the file
// SILENTLY is not an option either — the employee would believe the document was sent.

/** Reviews-with-attachment per hour across the whole receiving repository. */
export const REPO_ATTACH_LIMIT = 60
export const REPO_WINDOW_MS = 60 * 60 * 1000

/**
 * Per-PORTAL share of that ceiling.
 *
 * Without it the global limit protected the receiver from the crowd but not from ONE tenant: the
 * per-employee limit is 12 per 10 minutes, i.e. 72 an hour — more than the whole repository budget,
 * so a single busy portal could starve every other tenant without ever hitting its own limit. The
 * two numbers were never reconciled; now they are, and by construction: one portal can spend at
 * most a sixth of the hour's attachments.
 */
export const PORTAL_ATTACH_LIMIT = 10

const store = windowCounterStore(connectionOptions())

/**
 * ⚠ Without Redis this limit is FAIL-CLOSED — attachments are not uploaded at all.
 *
 * The per-employee limiters fall back to an in-process count because there the fallback still does
 * their job (bounding one person's loop). Here it does not: the whole point is a ceiling on a
 * SHARED receiver, and «per-process ceiling» is not a weaker version of that, it is a different and
 * wrong thing — several processes would each grant a full budget, which is exactly the outage this
 * exists to prevent. So a missing/broken store means we do not know the shared spend, and we stop
 * sending files rather than pretend. Reviews keep arriving; only the attachment is dropped, with the
 * employee told why. The state is logged, so «the limit is not in effect» can never be a surprise.
 */
export function createAttachBudget(counter: WindowCounterStore | null, log: (m: string) => void = console.info) {
  const onDegrade = (reason: string) =>
    log(`[feedback-repo] shared attachment budget unavailable (${reason}) — attachments are OFF until it is back`)
  const spec = { prefix: 'feedback-repo', windowMs: REPO_WINDOW_MS }
  const repo = createSharedLimiter({ ...spec, limit: REPO_ATTACH_LIMIT }, counter, onDegrade)
  const portal = createSharedLimiter({ ...spec, limit: PORTAL_ATTACH_LIMIT }, counter, onDegrade)

  return async (memberId: string, nowMs: number): Promise<AttachBudgetDecision> => {
    // The portal share is checked FIRST and short-circuits: a tenant that has already spent its own
    // share must not keep ticking the global counter, or it would drain the receiver anyway — just
    // while being refused.
    const own = await portal.check(`portal:${memberId}`, nowMs)
    const d = own.allowed ? await repo.check('repo', nowMs) : own
    // Degraded = the count is not shared (see the block comment above) ⇒ no attachment.
    const allowed = d.allowed && !d.degraded
    // Spend is logged so «the ceiling was reached» can never be a surprise, and so «the ceiling is
    // not in effect» is visible BEFORE it matters.
    log(`[feedback-repo] attachments ${d.used}/${d.limit} this hour${own.allowed ? '' : ' (portal share)'}${d.degraded ? ' (unshared count — attachments off)' : ''}`)
    return { allowed, ...(allowed ? {} : { notice: ATTACH_DROPPED_NOTICE }), degraded: d.degraded, used: d.used, limit: d.limit }
  }
}

const attachments = createAttachBudget(store)

export interface AttachBudgetDecision {
  /** May this review carry its file? */
  allowed: boolean
  /** Text for the employee when it may not — never silence. */
  notice?: string
  /** True when the answer came from an unshared count, i.e. the ceiling is not actually in effect. */
  degraded: boolean
  used: number
  limit: number
}

/** Message shown when the file is dropped. Says what happened AND what still went through. */
export const ATTACH_DROPPED_NOTICE
  = 'Отзыв отправлен, но документ приложить не удалось — сейчас идёт много отзывов с файлами. Текст отзыва мы получили.'

/**
 * Файл не ушёл по любой другой причине: задание истекло, страница не прислала байты, архива на
 * Диске нет, приёмник не подтверждён приватным. Причины разные, исход для человека один — и он
 * обязан быть назван: «Спасибо за отзыв!» без оговорки читается как «документ ушёл».
 */
export const ATTACH_MISSING_NOTICE
  = 'Отзыв отправлен, но документ приложить не удалось. Текст отзыва мы получили.'

/**
 * Ask whether THIS review may carry its file. Counts one tick when it may.
 *
 * The counter is only touched when a file is actually being sent: a review without an attachment
 * costs the receiver one small issue and must never be squeezed out by a budget meant for files.
 */
export async function checkAttachBudget(memberId: string, nowMs: number): Promise<AttachBudgetDecision> {
  return attachments(memberId, nowMs)
}
