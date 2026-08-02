import { createRateLimiter, type RateLimitDecision } from './demoRateLimit'

// Rate limit for the in-portal upload route (PROCESS.md §6.8 «открытый вектор»).
//
// Until now nothing bounded how fast one person could submit documents. That was tolerable while a
// failure went only into the uploader's own list — they were spamming themselves. It stopped being
// tolerable once every failure also writes to the ADMIN's error chat with no quiet period (owner's
// decision, #289): N junk files became N messages in somebody else's chat. The right place to stop
// that is the door, not the chat — muting the chat would also hide real failures, while refusing at
// intake keeps every ACCEPTED failure visible.
//
// It BOUNDS the vector, it does not close it: 40 per person per 10 minutes still allows 240 messages
// an hour, and more people means more of them. What it stops is the unattended loop.
//
// NB it does NOT save the portal's REST budget on the refusals themselves — the key comes from the
// verified frame token, so every refused request has already spent one `profile` call proving who is
// asking. Checking earlier would mean trusting a client-supplied id, which is worse. What it does
// save is the amplification behind each accepted upload (extract → agent → crm-sync).
//
// Keyed per PORTAL USER, not per IP. A portal is a company: everyone in the office can share one
// external address, so an IP limit would make one person's bulk import throttle their colleagues.
// The member_id + user id come from the verified frame token, so the key cannot be forged.

/** How many uploads one person may start per window. Deliberately generous: a real batch of
 *  invoices is a normal morning's work, and a limit that interrupts it would be worse than the
 *  noise it prevents. What it stops is the unattended loop, not the busy accountant. */
export const UPLOAD_LIMIT = 40
/** Window for `UPLOAD_LIMIT`. */
export const UPLOAD_WINDOW_MS = 10 * 60 * 1000

// In-process, like the demo limiter. Honest about what that means: the count lives in memory, so it
// resets on restart, and with several HTTP replicas each keeps its own — the effective limit would
// be N×40. Today the API is served by one instance (the `worker` role runs with QUEUE_CRON=0 and is
// not behind nginx), and the point here is to bound an unattended loop, not to enforce an exact
// quota — a distributed counter would add a Redis round-trip to every upload for accuracy nobody
// needs. If the HTTP role is ever scaled, this has to move to Redis or the limit becomes a fiction.
const limiter = createRateLimiter(UPLOAD_LIMIT, UPLOAD_WINDOW_MS)

/**
 * Key for one uploader.
 *
 * Falls back to the portal alone when the portal reported no user id: better to bound the whole
 * portal than to hand out an unlimited bucket to anyone whose profile lacks an id.
 *
 * The `|` matters: `member_id` is hex and a user id is digits, so without a separator portal `m1`
 * + user `17` and portal `m11` + user `7` would share one bucket, and one person's batch would eat
 * a stranger's limit.
 */
export function uploadRateKey(memberId: string, userId?: string | null): string {
  return `${memberId}|${userId ?? ''}`
}

/** Check (and count) one upload attempt. */
export function checkUploadRate(memberId: string, userId: string | null | undefined, nowMs: number): RateLimitDecision {
  return limiter.check(uploadRateKey(memberId, userId), nowMs)
}

/** Message for the person who hit the limit — says what to do, not just that they were refused. */
export function uploadRateMessage(retryAfterMs: number): string {
  const min = Math.max(1, Math.ceil(retryAfterMs / 60_000))
  return `Слишком много загрузок подряд. Попробуйте снова через ${min} мин.`
}

/** Test seam — the limiter is process-wide by design. */
export function resetUploadRateLimit(): void {
  limiter.sweep(Number.MAX_SAFE_INTEGER)
}

// ── Feedback channel (#349 review) ────────────────────────────────────────────
//
// The feedback route used to be cheap: a short JSON body, one GitHub issue. Since the source file
// travels WITH the rating (the server keeps no copy any more), one authenticated employee can loop
// «issue + ≤5 MB commit» per job and burn the publisher's shared GitHub quota / bloat the private
// repo. The privacy probe and the path scoping bound WHAT can be written; nothing bounded HOW OFTEN.
//
// Stricter than the upload limit on purpose: rating a run is a deliberate, occasional act — a person
// who legitimately sends more than a dozen ratings in ten minutes is not describing what went wrong.
export const FEEDBACK_LIMIT = 12
export const FEEDBACK_WINDOW_MS = 10 * 60 * 1000

const feedbackLimiter = createRateLimiter(FEEDBACK_LIMIT, FEEDBACK_WINDOW_MS)

/** Check (and count) one feedback submission. Same per-person key as uploads (see `uploadRateKey`). */
export function checkFeedbackRate(memberId: string, userId: string | null | undefined, nowMs: number): RateLimitDecision {
  return feedbackLimiter.check(uploadRateKey(memberId, userId), nowMs)
}

/** Message for the person who hit the feedback limit. */
export function feedbackRateMessage(retryAfterMs: number): string {
  const min = Math.max(1, Math.ceil(retryAfterMs / 60_000))
  return `Слишком много отзывов подряд. Попробуйте снова через ${min} мин.`
}

/** Test seam. */
export function resetFeedbackRateLimit(): void {
  feedbackLimiter.sweep(Number.MAX_SAFE_INTEGER)
}
