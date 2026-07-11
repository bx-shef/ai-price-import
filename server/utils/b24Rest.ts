// Pure Bitrix24 REST helpers. Transport (fetch) is injected — no ambient I/O.

/** Minimal fetch-like signature we depend on. */
export type FetchFn = (url: string, init?: { method?: string, headers?: Record<string, string>, body?: string }) => Promise<{ ok: boolean, status: number, json: () => Promise<unknown> }>

/** A bound REST caller for one portal (domain + access token). */
export type RestCall = (method: string, params?: Record<string, unknown>) => Promise<unknown>

/** Normalise a portal domain to a bare host. */
export function normaliseHost(domain: string): string {
  return domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim().toLowerCase()
}

/** SSRF guard: only allow Bitrix24 cloud hosts (the portal domain comes from the install event). */
export function isSafeB24Domain(domain: string): boolean {
  const host = normaliseHost(domain)
  if (!host || host.includes('@') || host.includes(':')) return false
  return /^([a-z0-9-]+\.)+bitrix24\.[a-z]{2,}$/.test(host) || host === 'oauth.bitrix24.tech'
}

/** Build a REST endpoint URL for a cloud portal domain + method. Throws on unsafe host. */
export function restUrl(domain: string, method: string): string {
  const host = normaliseHost(domain)
  if (!isSafeB24Domain(host)) throw new B24RestError('UNSAFE_DOMAIN', `refusing REST to ${host}`)
  return `https://${host}/rest/${method}.json`
}

/** Typed B24 REST error carrying the machine-readable error code + HTTP status,
 * so callers can detect `expired_token`/`invalid_token` and retry after refresh. */
export class B24RestError extends Error {
  constructor(readonly code: string, readonly description: string, readonly status = 0) {
    super(`b24 rest: ${code}${description ? `: ${description}` : ''}`)
    this.name = 'B24RestError'
  }
}

/** True when the error means the access token must be refreshed and the call retried. */
export function isExpiredTokenError(err: unknown): boolean {
  return err instanceof B24RestError && (err.code === 'expired_token' || err.code === 'invalid_token')
}

/** True when a REST error means the auth token was REJECTED (forbidden) rather than a
 * transport/network failure — lets callers tell "unauthorised" from "retry later". */
export function isAuthRejection(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return /invalid_token|expired_token|wrong_auth|no_auth|unauthorized|authoriz|invalid_grant|access denied|insufficient_scope|\b401\b|\b403\b/.test(msg)
}

/** Extract `result` from a B24 response or throw a typed B24RestError. */
export function unwrap(raw: unknown, status = 0): unknown {
  const o = raw as Record<string, unknown> | null
  if (o && typeof o === 'object' && 'error' in o) {
    throw new B24RestError(String(o.error), o.error_description ? String(o.error_description) : '', status)
  }
  return o?.result
}

/** Make a bound RestCall for a portal using an injected fetch. */
export function makeRestCall(domain: string, accessToken: string, fetchFn: FetchFn): RestCall {
  return async (method, params = {}) => {
    const res = await fetchFn(restUrl(domain, method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...params, auth: accessToken })
    })
    let json: unknown
    try {
      json = await res.json()
    } catch {
      throw new B24RestError('INVALID_RESPONSE', `non-JSON body (HTTP ${res.status})`, res.status)
    }
    return unwrap(json, res.status)
  }
}
