// Pure access-token lifetime logic + proactive keep-alive selection.
// access_token lives ~1h; refresh_token lives 180 days (docs/redesign 02 §4).

const HOUR_MS = 3600_000
const DAY_MS = 86_400_000

/** refresh_token lifetime per Bitrix24 (180 days). */
export const REFRESH_TTL_DAYS = 180

/** Is the access token expired (with a safety skew, default 60s)? */
export function isAccessTokenExpired(issuedAtMs: number, expiresInSec: number, nowMs: number, skewMs = 60_000): boolean {
  const expiresAt = issuedAtMs + (expiresInSec > 0 ? expiresInSec * 1000 : HOUR_MS)
  return nowMs + skewMs >= expiresAt
}

/**
 * Should this portal's refresh_token be proactively renewed now?
 * True when it is within `thresholdDays` (default 3) of its 180-day expiry —
 * i.e. last refreshed more than (180 - threshold) days ago. Idle portals only.
 */
export function needsProactiveRefresh(refreshedAtMs: number, nowMs: number, thresholdDays = 3): boolean {
  const ageMs = nowMs - refreshedAtMs
  return ageMs >= (REFRESH_TTL_DAYS - thresholdDays) * DAY_MS
}
