import { buildRefreshParams, parseTokenResponse } from './b24Oauth'
import { isAccessTokenExpired } from './accessToken'
import type { PortalToken, SaveTokenInput } from './tokenStore'

// Ensure a fresh access token for a portal: use the stored one, or refresh via
// the injected transport and persist the new pair. Pure logic, all I/O injected.

export interface EnsureDeps {
  getToken: (memberId: string) => Promise<PortalToken | null>
  saveToken: (input: SaveTokenInput) => Promise<void>
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

  if (!force && tok.accessToken && !isAccessTokenExpired(tok.issuedAtMs, tok.expiresIn, deps.now())) {
    return { accessToken: tok.accessToken, domain: tok.domain, clientEndpoint: tok.clientEndpoint }
  }

  if (!tok.refreshTokenEnc) throw new Error(`ensureFreshToken: no refresh token for portal ${memberId}`)
  const refresh = deps.decrypt(tok.refreshTokenEnc)
  const raw = await deps.refreshTransport(buildRefreshParams(deps.clientId, deps.clientSecret, refresh))
  const parsed = parseTokenResponse(raw)
  const now = deps.now()

  // Keep the PORTAL domain (from install); parsed.domain is the oauth server.
  await deps.saveToken({
    memberId,
    domain: tok.domain,
    clientEndpoint: parsed.client_endpoint || tok.clientEndpoint,
    accessToken: parsed.access_token,
    refreshTokenEnc: deps.encrypt(parsed.refresh_token),
    expiresIn: parsed.expires_in,
    issuedAtMs: now,
    refreshedAtMs: now
  })
  return { accessToken: parsed.access_token, domain: tok.domain, clientEndpoint: parsed.client_endpoint || tok.clientEndpoint }
}
