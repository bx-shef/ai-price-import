import type { FetchFn } from './b24Rest'
import { isAuthRejection, makeRestCall, normaliseHost } from './b24Rest'
import type { QueryFn } from './tokenStore'
import { getMemberIdByDomain } from './tokenStore'
import type { FrameAuth } from './frameAuth'

// Securely bind an in-portal frame request to a portal member_id. The client cannot
// be trusted to send member_id (cross-portal document-injection risk), so we:
//  1) VERIFY the frame access token controls `domain` (a cheap authenticated REST call);
//  2) derive member_id from `domain` via the token store (installed-portal 1:1).
// DI over fetch + query → unit-tested. docs/redesign 02 §8.

export interface FrameMemberDeps {
  fetchFn: FetchFn
  query: QueryFn
}

/** Why resolution failed (for diagnostics — surfaced by the caller). */
export type FrameMemberReason = 'token-rejected' | 'transport' | 'not-installed'

export interface FrameMemberResult {
  ok: boolean
  memberId?: string
  /** True when the CALLING user is a portal administrator (profile.ADMIN). The frame token
   *  is that user's token, so this reflects the caller — an admin-only route gates on it. */
  admin?: boolean
  /** 401 = token invalid / not installed; 502 = verification transport error. */
  status?: 401 | 502
  reason?: FrameMemberReason
}

/** Verify the frame token and resolve member_id, or an error status. Never throws. */
export async function resolveFrameMember(auth: FrameAuth, deps: FrameMemberDeps): Promise<FrameMemberResult> {
  // 1. Verify the token is valid for this portal (profile is a cheap authed method). Its
  // result ALSO carries the caller's ADMIN flag (the frame token is the calling user's), so
  // the same call doubles as the admin-gate source — no extra REST round-trip.
  let admin: boolean
  try {
    const profile = await makeRestCall(auth.domain, auth.accessToken, deps.fetchFn)('profile') as { ADMIN?: unknown } | null
    admin = profile?.ADMIN === true
  } catch (e) {
    // An auth rejection means the token doesn't control the portal → 401; a transport
    // failure (network) → 502 so the client retries rather than treating it as forbidden.
    const rejected = isAuthRejection(e)
    return { ok: false, status: rejected ? 401 : 502, reason: rejected ? 'token-rejected' : 'transport' }
  }
  // 2. Map the (now-verified) domain to the installed portal's member_id. Normalise the
  // host (lower-case, strip scheme/path) so a frame domain that differs only in case or
  // form from the stored install domain still matches (getMemberIdByDomain is exact).
  const memberId = await getMemberIdByDomain(normaliseHost(auth.domain), deps.query)
  if (!memberId) return { ok: false, status: 401, reason: 'not-installed' }
  return { ok: true, memberId, admin }
}
