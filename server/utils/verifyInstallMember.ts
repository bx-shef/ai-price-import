import { buildRefreshParams, parseTokenResponse, type B24TokenResponse } from './b24Oauth'
import type { FetchFn } from './b24Rest'
import { REST_TIMEOUT_MS, isAuthRejection } from './b24Rest'

// Install-time member_id binding (#162). The first ONAPPINSTALL delivers member_id as a
// CLIENT-CONTROLLED field; verifyInstallToken proves control of the DOMAIN (a `profile` call)
// but NOT of member_id. Without binding, an attacker who controls any real portal A can forge an
// install with a victim's member_id + A's valid token → poisons the victim's member_id (targeted
// install-poisoning DoS, #162). We bind it by refreshing the delivered refresh_token: the OAuth
// token endpoint returns the AUTHORITATIVE member_id of that grant, which must equal the claimed one.
//
// DELIBERATE non-SDK exception to "all B24 via @bitrix24/b24jssdk" (#160): the SDK's refreshAuth
// DISCARDS the response's member_id (oauth/auth.mjs updates access/refresh/expires/endpoint/scope
// but never member_id), so it CANNOT surface the authoritative id. This one raw OAuth-token POST is
// the only way to read it. Host is FIXED (oauth.bitrix.info — not client-controlled → no SSRF),
// secrets ride in the POST body (never the URL → no access-log leak), AbortSignal-bounded.

/** B24 OAuth token endpoint. FIXED host (not derived from client input) — no SSRF surface.
 *  `oauth.bitrix.info` mirrors the SDK's own refresh server endpoint (b24Sdk.B24_SERVER_ENDPOINT),
 *  so install-time and steady-state (keep-alive/reauth) refreshes hit the SAME OAuth host. */
const OAUTH_TOKEN_URL = 'https://oauth.bitrix.info/oauth/token/'

/** Raw OAuth token-refresh POST → parsed JSON. The ONE sanctioned non-SDK B24 call (see header):
 *  the SDK drops the response's member_id, which install-poisoning defence needs. Injected fetch. */
export function rawOauthRefresh(fetchFn: FetchFn, timeoutMs = REST_TIMEOUT_MS): (params: Record<string, string>) => Promise<unknown> {
  return async (params) => {
    const res = await fetchFn(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(timeoutMs)
    })
    return res.json()
  }
}

export interface InstallMemberDeps {
  /** Performs the OAuth token refresh with the given params, returns the parsed JSON. */
  refresh: (params: Record<string, string>) => Promise<unknown>
  clientId: string
  clientSecret: string
}

/** The rotated grant returned by a successful bind — the caller MUST store THIS (not the delivered
 *  creds): refreshing rotated the token, so the delivered refresh_token is now stale. `refreshToken`
 *  is plaintext; the caller encrypts it before persistence. */
export interface RefreshedGrant {
  accessToken: string
  refreshToken: string
  clientEndpoint: string
  expiresIn: number
}

export interface InstallMemberResult {
  ok: boolean
  /** 403 = member_id rejected (spoofed / forged grant); 503 = cannot verify now (network/config). */
  status?: 403 | 503
  grant?: RefreshedGrant
}

/** Verify the claimed install member_id against the authoritative one from the OAuth grant (#162).
 *  Refreshes the delivered refresh_token, compares the returned member_id, and hands back the
 *  ROTATED grant to store. Fail-closed: any doubt (network/config/no member_id) → 503, explicit
 *  mismatch or a rejected/forged grant → 403. Never throws. */
export async function verifyInstallMember(claimedMemberId: string, refreshToken: string, deps: InstallMemberDeps): Promise<InstallMemberResult> {
  const claimed = claimedMemberId.trim().toLowerCase()
  // No claimed id or no refresh token ⇒ nothing to bind against ⇒ reject (fail closed).
  if (!claimed || !refreshToken) return { ok: false, status: 403 }
  let raw: unknown
  try {
    raw = await deps.refresh(buildRefreshParams(deps.clientId, deps.clientSecret, refreshToken))
  } catch {
    return { ok: false, status: 503 } // transport / network — cannot verify now
  }
  // Coerce non-objects to {} BEFORE the `in` operator — a JSON primitive (a misconfigured proxy
  // returning a bare string/number) would make `'error' in <primitive>` throw, escaping the
  // fail-closed contract and 500-ing the webhook. A primitive then fails parseTokenResponse → 503.
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  if ('error' in o) {
    // OAuth error response. Classify by the machine CODE (not the human error_description, which
    // parseTokenResponse would surface): invalid_grant/invalid_token/… ⇒ the token isn't a genuine
    // grant ⇒ forged install → 403. wrong_client / anything else ⇒ OUR config, retryable → 503.
    return { ok: false, status: isAuthRejection(String(o.error)) ? 403 : 503 }
  }
  let parsed: B24TokenResponse
  try {
    parsed = parseTokenResponse(raw)
  } catch {
    return { ok: false, status: 503 } // malformed success (no tokens) — cannot verify
  }
  const authoritative = String(parsed.member_id ?? '').trim().toLowerCase()
  // Genuine grant always echoes member_id; empty ⇒ cannot bind ⇒ 503 (don't false-reject a real install).
  if (!authoritative) return { ok: false, status: 503 }
  // The token belongs to a DIFFERENT portal than the event claims ⇒ forged install → 403.
  if (authoritative !== claimed) return { ok: false, status: 403 }
  return {
    ok: true,
    grant: {
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
      clientEndpoint: parsed.client_endpoint || '',
      expiresIn: parsed.expires_in
    }
  }
}
