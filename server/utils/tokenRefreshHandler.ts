import type { ReauthOutcome } from './portalReauth'

// Pure {status, body} decision for POST /api/ops/tokens/refresh (#132) — DI over the reauth
// action so it unit-tests without DB/network. The route does I/O + operator auth only.

export interface RefreshHandlerDeps {
  /** True when B24_CLIENT_ID/SECRET are set — without them a refresh is impossible. */
  configured: boolean
  /** Force-refresh a portal (server/utils/portalReauth.reauthPortal). NON-SECRET outcome. */
  reauth: (memberId: string) => Promise<ReauthOutcome>
}

/** A B24 member_id is a hex id — validate before it reaches the advisory-lock key / query. */
function validMemberId(v: unknown): v is string {
  return typeof v === 'string' && /^[a-f0-9]{8,64}$/i.test(v.trim())
}

/** Decide the response for a reauth request. Never returns a token. */
export async function handleTokenRefresh(
  memberId: unknown,
  deps: RefreshHandlerDeps
): Promise<{ status: number, body: Record<string, unknown> }> {
  if (!deps.configured) return { status: 503, body: { error: 'oauth not configured' } }
  if (!validMemberId(memberId)) return { status: 400, body: { error: 'invalid memberId' } }
  const outcome = await deps.reauth(memberId.trim())
  if (outcome === 'refreshed') return { status: 200, body: { ok: true, outcome } }
  if (outcome === 'not-installed') return { status: 409, body: { error: 'portal not installed', outcome } }
  return { status: 502, body: { error: 'refresh failed', outcome } }
}
