// Pure Bitrix24 REST helpers. Transport (fetch) is injected — no ambient I/O.

/** Minimal fetch-like signature we depend on. */
export type FetchFn = (url: string, init?: { method?: string, headers?: Record<string, string>, body?: string }) => Promise<{ ok: boolean, status: number, json: () => Promise<unknown> }>

/** A bound REST caller for one portal (domain + access token). */
export type RestCall = (method: string, params?: Record<string, unknown>) => Promise<unknown>

/** Build a REST endpoint URL for a cloud portal domain + method. */
export function restUrl(domain: string, method: string): string {
  const host = domain.replace(/^https?:\/\//, '').replace(/\/$/, '')
  return `https://${host}/rest/${method}.json`
}

/** Extract `result` from a B24 response or throw a descriptive error. */
export function unwrap(raw: unknown): unknown {
  const o = raw as Record<string, unknown>
  if (o && 'error' in o) {
    throw new Error(`b24 rest: ${String(o.error)}${o.error_description ? `: ${String(o.error_description)}` : ''}`)
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
    const json = await res.json()
    return unwrap(json)
  }
}
