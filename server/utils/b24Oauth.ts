// Pure OAuth helpers for Bitrix24 token refresh (no I/O — transport injected).
// See https://apidocs.bitrix24.ru/api-reference/oauth/auto-renewal.html

export const B24_OAUTH_URL = 'https://oauth.bitrix24.tech/oauth/token/'

export interface B24TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  member_id: string
  client_endpoint: string
  server_endpoint?: string
  domain?: string
  scope?: string
  status?: string
}

/** Build refresh request params. Caller MUST send these in the POST body, never in the URL
 * query (a client_secret/token in a query string would land in access logs). */
export function buildRefreshParams(clientId: string, clientSecret: string, refreshToken: string): Record<string, string> {
  return {
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken
  }
}

/** Validate/normalise a token response. Throws on missing required fields. */
export function parseTokenResponse(raw: unknown): B24TokenResponse {
  const o = raw as Record<string, unknown>
  if (!o || typeof o.access_token !== 'string' || typeof o.refresh_token !== 'string') {
    const err = (o && (o.error_description || o.error)) as string | undefined
    throw new Error(`b24 oauth: invalid token response${err ? `: ${err}` : ''}`)
  }
  return {
    access_token: o.access_token,
    refresh_token: o.refresh_token,
    expires_in: Number(o.expires_in ?? 3600),
    member_id: String(o.member_id ?? ''),
    client_endpoint: String(o.client_endpoint ?? ''),
    server_endpoint: o.server_endpoint ? String(o.server_endpoint) : undefined,
    domain: o.domain ? String(o.domain) : undefined,
    scope: o.scope ? String(o.scope) : undefined,
    status: o.status ? String(o.status) : undefined
  }
}
