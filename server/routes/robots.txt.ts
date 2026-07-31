import { siteBaseUrl } from '~/utils/landing'
import { buildRobotsTxt } from '../utils/seoFiles'
import { assertReadOnlyMethod } from '../utils/crawlerRoute'

// /robots.txt — crawl policy for the public landing. Body is the pure `buildRobotsTxt`; the only I/O
// here is resolving the absolute base (configured deployment URL → canonical landing home).
// Deliberately NOT a static public/ file: the Sitemap: line needs an absolute host, which varies.
//
// No `.get` suffix in the filename ON PURPOSE: that registers the handler for GET only, and h3 does
// not fall back HEAD→GET, so `HEAD /robots.txt` would 404. Crawler tooling probes this file with HEAD.
// The trade-off is that an unsuffixed file answers EVERY method, so the guard below restores 405 —
// without it `PUT`/`DELETE`/`TRACE` returned 200 (a stock scanner finding on a public domain), and a
// 2xx to an unsafe method makes shared caches invalidate the stored entry (RFC 9111 §4.4).

export default defineEventHandler((event) => {
  assertReadOnlyMethod(event)
  const base = siteBaseUrl(useRuntimeConfig(event).public.siteUrl)
  setResponseHeader(event, 'content-type', 'text/plain; charset=utf-8')
  // Crawl policy changes rarely; let intermediaries hold it for a day.
  setResponseHeader(event, 'cache-control', 'public, max-age=86400')
  return buildRobotsTxt(base)
})
