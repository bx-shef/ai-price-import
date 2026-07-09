import { timingSafeEqual } from 'node:crypto'
import type { ParsedB24Event } from '~/utils/b24Events'

// Pure read-only verdict for an incoming B24 event: verify application_token
// (fail-closed, constant-time) and decide the action. Does NOT write — the queue
// consumer is the single writer. See docs/redesign 02 §4.

export type B24EventAction = 'register' | 'unregister' | 'ignore'

export interface B24EventDecision {
  /** HTTP status the endpoint should return. */
  status: 200 | 400 | 403 | 503
  action: B24EventAction
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
 * @param expectedToken the trusted application_token: env value (bootstrap) or the
 *        stored one for this portal. When empty → 503 (not configured).
 */
export function decideB24Event(ev: ParsedB24Event, expectedToken: string): B24EventDecision {
  if (!ev.event || !ev.memberId) return { status: 400, action: 'ignore' }
  if (!expectedToken) return { status: 503, action: 'ignore' }
  if (!safeEqual(ev.applicationToken, expectedToken)) return { status: 403, action: 'ignore' }
  if (ev.event === 'ONAPPINSTALL') return { status: 200, action: 'register' }
  if (ev.event === 'ONAPPUNINSTALL') return { status: 200, action: 'unregister' }
  return { status: 200, action: 'ignore' }
}
