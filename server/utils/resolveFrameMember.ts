import type { RestCall } from './b24Rest'
import { isAuthRejection, normaliseHost } from './b24Rest'
import { makeBareTokenSdkCall } from './b24Sdk'
import type { QueryFn } from './tokenStore'
import { getMemberIdByDomain } from './tokenStore'
import type { FrameAuth } from './frameAuth'

// Securely bind an in-portal frame request to a portal member_id. The client cannot
// be trusted to send member_id (cross-portal document-injection risk), so we:
//  1) VERIFY the frame access token controls `domain` (a cheap authenticated REST call);
//  2) derive member_id from `domain` via the token store (installed-portal 1:1).
// DI over fetch + query → unit-tested. docs/PROCESS.md

export interface FrameMemberDeps {
  query: QueryFn
  /** Bare-token REST factory. Prod uses the SDK transport (makeBareTokenSdkCall); tests inject
   *  a fake so verification logic stays unit-testable without a live portal. */
  makeCall?: (domain: string, accessToken: string) => RestCall
}

/** Why resolution failed (for diagnostics — surfaced by the caller). */
export type FrameMemberReason = 'token-rejected' | 'transport' | 'not-installed'

/** Deps for the lighter token-only verification (no token store). */
export interface FrameVerifyDeps {
  makeCall?: (domain: string, accessToken: string) => RestCall
}

export interface FrameVerifyResult {
  ok: boolean
  /** True when the calling user is a portal administrator (profile.ADMIN). */
  admin?: boolean
  /** Portal id of the calling user (profile.ID). */
  userId?: string
  status?: 401 | 502
  reason?: 'token-rejected' | 'transport'
}

/**
 * Verify a frame token controls its portal (a cheap authed `profile` call) and read the caller's
 * ADMIN flag — WITHOUT requiring the portal be installed (no member_id / token-store lookup). For
 * routes that operate on the frame token ALONE (settings `app.option` read/write is portal-scoped by
 * that token), so a not-installed/install-race window doesn't wrongly reject a valid admin. Never
 * throws. `resolveFrameMember` builds on this and adds the member_id resolution.
 */
export async function verifyFrameToken(auth: FrameAuth, deps: FrameVerifyDeps = {}): Promise<FrameVerifyResult> {
  try {
    const makeCall = deps.makeCall ?? makeBareTokenSdkCall
    const profile = await makeCall(auth.domain, auth.accessToken)('profile') as { ADMIN?: unknown, ID?: unknown } | null
    return { ok: true, admin: profile?.ADMIN === true, userId: profileUserId(profile?.ID) }
  } catch (e) {
    const rejected = isAuthRejection(e)
    return { ok: false, status: rejected ? 401 : 502, reason: rejected ? 'token-rejected' : 'transport' }
  }
}

/**
 * Portal user id from `profile.ID` — a positive integer as a string, or undefined.
 *
 * B24 returns it as a string on some portals and a number on others, so both are accepted. Anything
 * else is DROPPED, not coerced: a plain `Number()` quietly turns `'0x10'` into 16, `'1e3'` into
 * 1000 and `true` into 1 — every one of those is a valid id of a DIFFERENT person, so the failure
 * notice would land in an uninvolved employee's personal chat. Matches the storage-side check in
 * `jobStore.getUploaderId` exactly.
 */
export function profileUserId(raw: unknown): string | undefined {
  if (typeof raw === 'number') return Number.isInteger(raw) && raw > 0 ? String(raw) : undefined
  return typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw.trim()) ? raw.trim() : undefined
}

export interface FrameMemberResult {
  ok: boolean
  memberId?: string
  /** True when the CALLING user is a portal administrator (profile.ADMIN). The frame token
   *  is that user's token, so this reflects the caller — an admin-only route gates on it. */
  admin?: boolean
  /** Portal id of the CALLING user (profile.ID) — who is doing this. Recorded on an import so the
   *  app can tell that person when their document fails, instead of leaving it in a list they may
   *  never reopen. Undefined when the portal didn't report it. */
  userId?: string
  /** 401 = token invalid / not installed; 502 = verification transport error. */
  status?: 401 | 502
  reason?: FrameMemberReason
}

/** Verify the frame token and resolve member_id, or an error status. Never throws. */
export async function resolveFrameMember(auth: FrameAuth, deps: FrameMemberDeps): Promise<FrameMemberResult> {
  // 1. Verify the token controls the portal + read the caller's ADMIN flag (one `profile` call).
  const verified = await verifyFrameToken(auth, { makeCall: deps.makeCall })
  if (!verified.ok) return { ok: false, status: verified.status, reason: verified.reason }
  // 2. Map the (now-verified) domain to the installed portal's member_id. Normalise the
  // host (lower-case, strip scheme/path) so a frame domain that differs only in case or
  // form from the stored install domain still matches (getMemberIdByDomain is exact).
  const memberId = await getMemberIdByDomain(normaliseHost(auth.domain), deps.query)
  if (!memberId) return { ok: false, status: 401, reason: 'not-installed' }
  return { ok: true, memberId, admin: verified.admin, userId: verified.userId }
}
