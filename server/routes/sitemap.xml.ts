import { isCanonicalHost } from '~/utils/landing'
import { crawlerFiles } from '../utils/seoFiles'
import { crawlerMethodGate } from '../utils/crawlerRoute'

// /sitemap.xml — one entry, the landing (the only indexable page). `lastmod` is the build date rather
// than `now`, so repeated fetches of an unchanged deployment report an unchanged date; no build date
// configured → the element is omitted (a wrong lastmod is worse than none).
//
// `buildDate` is read at REQUEST time, so it must be set on the RUNTIME stage of the image — a
// build-stage-only ENV reaches the prerendered HTML and nothing else (see the Dockerfile note).
// Filename carries no `.get` suffix so HEAD is answered too (see robots.txt.ts).

export default defineEventHandler((event) => {
  if (crawlerMethodGate(event) === 'no-content') return null
  const config = useRuntimeConfig(event)
  // #304: a non-canonical host (staging/Vibecode/client server) has no sitemap AT ALL — its robots
  // omits the `Sitemap:` line, and an empty urlset would be schema-invalid (sitemaps.org XSD wants
  // at least one <url>), which Search Console reports as an error. 404 is the honest answer.
  if (!isCanonicalHost(config.public.siteUrl)) {
    setResponseStatus(event, 404)
    return 'not found'
  }
  setResponseHeader(event, 'content-type', 'application/xml; charset=utf-8')
  setResponseHeader(event, 'cache-control', 'public, max-age=86400')
  return crawlerFiles(config.public.siteUrl, config.public.buildDate).sitemap
})
