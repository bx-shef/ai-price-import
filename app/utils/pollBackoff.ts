// Pure timing rule for the /app status poller. Extracted from useImport so the part that actually
// decides «ждём или сдаёмся» is testable without a browser, a frame handshake or $fetch (#268).

/** How often to re-poll status while a job is in flight. */
export const POLL_MS = 2500
/** Backoff for retrying the FIRST list load: the initial refresh can lose to the frame handshake or a
 *  transient 401/network blip, and before #268 nothing retried it — the poller only armed a timer while
 *  a job was active, and an empty list has none. */
export const FIRST_LOAD_RETRY_MS = [1000, 2000, 4000, 8000, 15000]
/** Stop after this many CONSECUTIVE failures so a dead frame token can't be polled forever. */
export const MAX_POLL_FAILURES = 5

export interface PollState {
  /** The list has loaded successfully at least once. */
  firstLoadOk: boolean
  /** Some job is not in a terminal state yet. */
  hasActive: boolean
  /** Consecutive failed polls so far. */
  failures: number
}

/**
 * Delay before the next poll, or `null` when no timer should be armed.
 *
 * Two reasons to keep going: a job is still running (steady POLL_MS), or the list has never loaded
 * (retry the first load on a backoff). Anything else stops the loop.
 */
export function nextPollDelay({ firstLoadOk, hasActive, failures }: PollState): number | null {
  if (failures >= MAX_POLL_FAILURES) return null
  if (firstLoadOk) return hasActive ? POLL_MS : null
  return FIRST_LOAD_RETRY_MS[Math.min(failures, FIRST_LOAD_RETRY_MS.length - 1)]!
}
