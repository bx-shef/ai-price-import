import { crawlerFiles } from '../utils/seoFiles'
import { crawlerMethodGate } from '../utils/crawlerRoute'

// /robots.txt — crawl policy for the public landing. Deliberately NOT a static public/ file: the
// `Sitemap:` line needs an absolute host, which differs per deploy.
//
// No `.get` suffix in the filename ON PURPOSE — that registers the handler for GET only, and h3 does
// not fall back HEAD→GET, so `HEAD /robots.txt` would 404 while crawler tooling probes with HEAD.
// `crawlerMethodGate` restores the method restriction that the suffix would have given.
//
// All logic lives in `crawlerFiles` (raw env → validated base → body): keeping the composition in one
// tested place is what stops a route from passing the raw `siteUrl` to a builder.

export default defineEventHandler((event) => {
  if (crawlerMethodGate(event) === 'no-content') return null
  setResponseHeader(event, 'content-type', 'text/plain; charset=utf-8')
  // Crawl policy changes rarely; let intermediaries hold it for a day.
  setResponseHeader(event, 'cache-control', 'public, max-age=86400')
  return crawlerFiles(useRuntimeConfig(event).public.siteUrl).robots
})
