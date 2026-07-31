import type { H3Event } from 'h3'

// Shared method gate for the two crawler files (/robots.txt, /sitemap.xml).
//
// Those route files deliberately carry NO `.get` suffix — that would register the handler for GET
// only, and h3 does not fall back HEAD→GET, so `HEAD /robots.txt` would 404 while crawler tooling
// routinely probes with HEAD. The cost of dropping the suffix is that the handler then answers EVERY
// method, so the gate is restored here instead. Without it `PUT`/`DELETE`/`TRACE` returned the full
// body with 200 — a stock automated-scanner finding on a public domain, and a 2xx to an unsafe method
// makes shared caches invalidate the stored entry (RFC 9111 §4.4), so an anonymous POST loop could
// keep evicting the file from a CDN.

/** Methods these read-only files answer. */
export const CRAWLER_ALLOWED_METHODS = 'GET, HEAD, OPTIONS'

/**
 * Gate a crawler route. Returns `'handle'` when the caller should render the body, `'no-content'` for
 * OPTIONS (capability discovery — answer with `Allow` and an empty 204, never the resource itself),
 * and throws 405 otherwise.
 *
 * `Allow` is set on BOTH the 405 and the OPTIONS reply: RFC 9110 §15.5.6 makes it a MUST on 405, and
 * a 405 without it is the same class of scanner finding this gate exists to remove.
 */
export function crawlerMethodGate(event: H3Event): 'handle' | 'no-content' {
  const method = event.method
  if (method === 'GET' || method === 'HEAD') return 'handle'
  setResponseHeader(event, 'allow', CRAWLER_ALLOWED_METHODS)
  if (method === 'OPTIONS') {
    setResponseStatus(event, 204)
    return 'no-content'
  }
  throw createError({ statusCode: 405, statusMessage: 'Method Not Allowed' })
}
