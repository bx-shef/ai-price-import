import { siteBaseUrl } from '~/utils/landing'
import { buildRobotsTxt } from '../utils/seoFiles'

// /robots.txt — crawl policy for the public landing. Body is the pure `buildRobotsTxt`; the only I/O
// here is resolving the absolute base (configured deployment URL → canonical landing home).
// Deliberately NOT a static public/ file: the Sitemap: line needs an absolute host, which varies.
//
// No `.get` suffix in the filename ON PURPOSE: that registers the handler for GET only, and h3 does
// not fall back HEAD→GET, so `HEAD /robots.txt` would 404. Crawler tooling probes this file with HEAD.

export default defineEventHandler((event) => {
  const base = siteBaseUrl(useRuntimeConfig(event).public.siteUrl)
  setResponseHeader(event, 'content-type', 'text/plain; charset=utf-8')
  // Crawl policy changes rarely; let intermediaries hold it for a day.
  setResponseHeader(event, 'cache-control', 'public, max-age=86400')
  return buildRobotsTxt(base)
})
