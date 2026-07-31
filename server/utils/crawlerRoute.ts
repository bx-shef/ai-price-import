import type { H3Event } from 'h3'

// Shared method gate for the two crawler files (/robots.txt, /sitemap.xml).
//
// Those route files deliberately carry NO `.get` suffix — that would register the handler for GET
// only, and h3 does not fall back HEAD→GET, so `HEAD /robots.txt` would 404 while crawler tooling
// routinely probes with HEAD. The cost of dropping the suffix is that the handler then answers EVERY
// method, so the gate is restored here instead: read-only verbs pass, everything else gets 405.
// Without it `PUT`/`DELETE`/`TRACE` returned the full body with 200 — a stock automated-scanner
// finding on a public domain, and a 2xx to an unsafe method makes shared caches invalidate the
// stored entry (RFC 9111 §4.4), so an anonymous POST loop could keep evicting the file from a CDN.

/** Allow GET/HEAD (and OPTIONS preflight); reject anything that could mutate. */
export function assertReadOnlyMethod(event: H3Event): void {
  const method = event.method
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return
  throw createError({ statusCode: 405, statusMessage: 'Method Not Allowed' })
}
