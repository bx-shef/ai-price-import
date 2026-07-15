import { buildRefreshParams, parseTokenResponse } from './b24Oauth'
import { isAccessTokenExpired } from './accessToken'
import type { PortalToken, QueryFn, SaveTokenInput } from './tokenStore'

// Ensure a fresh access token for a portal: use the stored one, or refresh via
// the injected transport and persist the new pair. Pure logic, all I/O injected.
//
// CONCURRENCY (scale-out, #35): the refresh is serialized per portal with a Postgres
// advisory lock, and re-reads the freshest token INSIDE the lock — so when N throughput
// workers hit the same near-expiry portal, exactly ONE refreshes (rotating the refresh
// token) and the rest reuse the result. Without this, concurrent refreshes race on B24's
// refresh-token rotation and permanently break the portal's stored credentials.

export interface EnsureDeps {
  /** Unlocked initial read (fast path — most calls find a still-valid token). */
  getToken: (memberId: string) => Promise<PortalToken | null>
  /** Serialize the refresh per portal; `fn` gets a QueryFn bound to the locked connection. */
  withLock: <T>(key: string, fn: (q: QueryFn) => Promise<T>) => Promise<T>
  /** Re-read the freshest token INSIDE the lock (on the locked connection `q`). */
  loadToken: (q: QueryFn, memberId: string) => Promise<PortalToken | null>
  /** Persist the rotated token INSIDE the lock (UPDATE-only — never resurrects a purged portal). */
  persistRefresh: (q: QueryFn, input: SaveTokenInput) => Promise<void>
  /** Performs the POST to the OAuth server with the given params; returns parsed JSON. */
  refreshTransport: (params: Record<string, string>) => Promise<unknown>
  decrypt: (enc: string) => string
  encrypt: (plain: string) => string
  clientId: string
  clientSecret: string
  now: () => number
}

export interface FreshToken {
  accessToken: string
  /** Portal REST host (from install DOMAIN, NOT the oauth server domain). */
  domain: string
  clientEndpoint: string
}

/**
 * Return a fresh access token for the portal. Refreshes when the access token is
 * expired (by time) or when `force` is set (e.g. after an expired_token REST error).
 */
export async function ensureFreshToken(memberId: string, deps: EnsureDeps, force = false): Promise<FreshToken> {
  const tok = await deps.getToken(memberId)
  if (!tok) throw new Error(`ensureFreshToken: no token for portal ${memberId}`)

  // Fast path: a still-valid token needs no refresh (and no lock — the common case).
  if (!force && tok.accessToken && !isAccessTokenExpired(tok.issuedAtMs, tok.expiresIn, deps.now())) {
    return { accessToken: tok.accessToken, domain: tok.domain, clientEndpoint: tok.clientEndpoint }
  }

  // Refresh needed → serialize per portal so N workers don't race on refresh-token rotation.
  return deps.withLock(`b24refresh:${memberId}`, async (q) => {
    // Re-read INSIDE the lock — another worker may have refreshed while we waited.
    const stored = await deps.loadToken(q, memberId)
    if (!stored) throw new Error(`ensureFreshToken: no token for portal ${memberId}`) // uninstalled under the lock
    if (!force && stored.accessToken && !isAccessTokenExpired(stored.issuedAtMs, stored.expiresIn, deps.now())) {
      return { accessToken: stored.accessToken, domain: stored.domain, clientEndpoint: stored.clientEndpoint }
    }
    if (!stored.refreshTokenEnc) throw new Error(`ensureFreshToken: no refresh token for portal ${memberId}`)

    const refresh = deps.decrypt(stored.refreshTokenEnc)
    const raw = await deps.refreshTransport(buildRefreshParams(deps.clientId, deps.clientSecret, refresh))
    const parsed = parseTokenResponse(raw)
    const now = deps.now()

    // Keep the PORTAL domain (from install); parsed.domain is the oauth server.
    await deps.persistRefresh(q, {
      memberId,
      domain: stored.domain,
      clientEndpoint: parsed.client_endpoint || stored.clientEndpoint,
      accessToken: parsed.access_token,
      refreshTokenEnc: deps.encrypt(parsed.refresh_token),
      expiresIn: parsed.expires_in,
      issuedAtMs: now,
      refreshedAtMs: now
    })
    return { accessToken: parsed.access_token, domain: stored.domain, clientEndpoint: parsed.client_endpoint || stored.clientEndpoint }
  })
}
