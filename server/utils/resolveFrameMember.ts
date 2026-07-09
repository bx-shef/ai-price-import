import type { FetchFn } from './b24Rest'
import { makeRestCall } from './b24Rest'
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

export interface FrameMemberResult {
  ok: boolean
  memberId?: string
  /** 401 = token invalid / not installed; 502 = verification transport error. */
  status?: 401 | 502
}

/** Verify the frame token and resolve member_id, or an error status. Never throws. */
export async function resolveFrameMember(auth: FrameAuth, deps: FrameMemberDeps): Promise<FrameMemberResult> {
  // 1. Verify the token is valid for this portal (profile is a cheap authed method).
  try {
    await makeRestCall(auth.domain, auth.accessToken, deps.fetchFn)('profile')
  } catch (e) {
    // An auth rejection means the token doesn't control the portal → 401; a transport
    // failure (network) → 502 so the client retries rather than treating it as forbidden.
    return { ok: false, status: isAuthError(e) ? 401 : 502 }
  }
  // 2. Map the (now-verified) domain to the installed portal's member_id.
  const memberId = await getMemberIdByDomain(auth.domain, deps.query)
  if (!memberId) return { ok: false, status: 401 }
  return { ok: true, memberId }
}

function isAuthError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase()
  return /invalid_token|expired_token|wrong_auth|no_auth|unauthorized|authoriz|invalid_grant|access denied|insufficient_scope|\b401\b|\b403\b/.test(msg)
}
