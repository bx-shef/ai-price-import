import { timingSafeEqual } from 'node:crypto'
import { resolveAuthConfig, verifySession } from './session'

// Shared operator-session constants + guard used by the auth routes and any
// operator-only endpoint (e.g. /api/ops/queues). Cookie is HttpOnly/SameSite=Lax/Secure.

export const OP_COOKIE = 'procure_op'
export const OP_MAX_AGE_MS = 8 * 60 * 60 * 1000 // 8 hours
export const OP_MAX_AGE_S = OP_MAX_AGE_MS / 1000

/** True when the cookie carries a valid, in-window operator session. */
export function operatorAllowed(cookie: string | undefined, env: Record<string, string | undefined>, now: number): boolean {
  const cfg = resolveAuthConfig(env)
  return verifySession(cookie ?? '', cfg.secret, now, OP_MAX_AGE_MS).valid
}

/** Constant-time app-token check for /api/queues (X-Check-Token). Fail-closed when
 * the expected token is unset — an empty provided header must NOT compare equal. */
export function opsTokenOk(expected: string, provided: string): boolean {
  if (!expected) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(provided)
  return a.length === b.length && timingSafeEqual(a, b)
}
