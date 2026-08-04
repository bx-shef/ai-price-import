import type { FrameMemberResult } from './resolveFrameMember'

// #411. The admin gate on «обнулить счётчики» used to live inline in the route, where the only thing
// watching it was a text guard over the source. That guard catches deletion and reordering and is
// blind by construction to the two mutations that actually matter: inverting the condition
// (`if (member.admin)` — the admin gets 403 while every employee wipes the portal's lifetime
// counters) and dropping the `return` (the wipe happens AND the response says 403, so the log and
// the telemetry both claim nothing was destroyed). Both keep every searched-for substring in place.
//
// So the decision moved here as a pure function with injected effects: the test can assert the thing
// that matters — that `reset` was NOT called — instead of asserting how the route is spelled.

/** Outcome of the reset request: an HTTP status plus the body to return. */
export interface MetricsResetResult {
  status: number
  /** Telemetry outcome for the surrounding span. Never carries a reason string from the portal. */
  outcome: 'ok' | 'no_auth' | 'auth_failed' | 'forbidden'
  body: Record<string, unknown>
}

export interface MetricsResetDeps {
  /** Verified frame member, or null when the request carried no frame auth at all. */
  member: FrameMemberResult | null
  /** Destructive effect. MUST NOT run unless the caller is a verified portal admin. */
  reset: (memberId: string) => Promise<void>
}

/**
 * Decide and (only then) perform the reset.
 *
 * Order is the whole point: every refusal returns before `reset` is reachable.
 */
export async function handleMetricsReset(deps: MetricsResetDeps): Promise<MetricsResetResult> {
  const { member, reset } = deps
  if (!member) {
    return { status: 401, outcome: 'no_auth', body: { error: 'frame auth required' } }
  }
  if (!member.ok || !member.memberId) {
    return { status: member.status ?? 401, outcome: 'auth_failed', body: { error: 'authorization failed', reason: member.reason } }
  }
  // ⚠ Strictly `!== true`, not falsiness: the flag comes from the portal's `profile` answer, and a
  // string «N» is truthy. Hiding the button in the UI is a convenience — this is the real check.
  if (member.admin !== true) {
    return { status: 403, outcome: 'forbidden', body: { error: 'admin only' } }
  }
  await reset(member.memberId)
  return { status: 200, outcome: 'ok', body: { ok: true } }
}
