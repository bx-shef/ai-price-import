import { timingSafeEqual } from 'node:crypto'
import type { ParsedB24Event } from '~/utils/b24Events'

// Pure read-only verdict for an incoming B24 event. Does NOT write — the queue
// consumer / endpoint is the single writer. See docs/PROCESS.md
//
// Trust model (Bitrix24 «Безопасность в обработчиках»,
// https://apidocs.bitrix24.ru/api-reference/events/safe-event-handlers.html):
// application_token is NOT a pre-shared secret — it is DELIVERED in the first
// ONAPPINSTALL and then remembered per-portal. So:
//   • Known portal (token already stored): verify the event's application_token
//     against the STORED one, constant-time. This is the only way to authenticate
//     ONAPPUNINSTALL (it carries no auth data — the app is already gone).
//   • First install (nothing stored yet): the token is being learned now — there is
//     nothing to compare it to. Authenticate via the delivered access_token instead
//     (verifyAccessToken=true → the endpoint pings a cheap authed REST method).
// An optional configured env token acts only as an extra global gate on first
// install; it is NOT required (empty is the normal setup).

export type B24EventAction = 'register' | 'unregister' | 'ignore'

export interface B24EventDecision {
  /** HTTP status the endpoint should return. */
  status: 200 | 400 | 403 | 503
  action: B24EventAction
  /** First install only: the endpoint must prove the delivered access_token controls
   * the portal (TOFU) before committing the register. */
  verifyAccessToken?: boolean
}

/** Constant-time string compare (fail-closed on length mismatch). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a ?? '', 'utf8')
  const bb = Buffer.from(b ?? '', 'utf8')
  if (ab.length === 0 || ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * Decide what to do with a parsed event.
 * @param storedToken the portal's remembered application_token, or null when the
 *        portal is unknown (never installed / already uninstalled).
 *
 * ⚠ There is NO global pre-shared token here, and there cannot be one. Bitrix24 issues
 * `application_token` PER INSTALLATION, so a single value from env could only ever match one
 * portal — every other tenant's first install would 403, silently, and the app would be
 * installable exactly once. The former `envToken` parameter offered that as an "optional extra
 * gate"; in a multitenant cloud app it is a switch that breaks the product for everyone else.
 * Its marginal value was nil even single-tenant: a first install is already authenticated by the
 * delivered access_token (`verifyAccessToken`) and bound to its member_id (#162).
 */
export function decideB24Event(ev: ParsedB24Event, storedToken: string | null): B24EventDecision {
  if (!ev.event || !ev.memberId) return { status: 400, action: 'ignore' }

  // Known portal → authoritative per-portal comparison (covers ONAPPUNINSTALL).
  if (storedToken) {
    if (!safeEqual(ev.applicationToken, storedToken)) return { status: 403, action: 'ignore' }
    if (ev.event === 'ONAPPINSTALL') return { status: 200, action: 'register' }
    if (ev.event === 'ONAPPUNINSTALL') return { status: 200, action: 'unregister' }
    return { status: 200, action: 'ignore' }
  }

  // Unknown portal → only a first install can bootstrap trust; anything else is
  // unverifiable (no stored token, and non-install events carry nothing to prove).
  if (ev.event !== 'ONAPPINSTALL') return { status: 403, action: 'ignore' }
  // A first install must carry an application_token to remember for later events.
  if (!ev.applicationToken) return { status: 400, action: 'ignore' }
  return { status: 200, action: 'register', verifyAccessToken: true }
}
