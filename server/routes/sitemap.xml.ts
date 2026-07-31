import { siteBaseUrl } from '~/utils/landing'
import { buildSitemapXml } from '../utils/seoFiles'

// /sitemap.xml — one entry, the landing (the only indexable page; see seoFiles). `lastmod` is the
// deploy date, taken from the build stamp rather than `now` so repeated fetches of an unchanged
// deployment report an unchanged date. No build date configured → the element is omitted (a wrong
// lastmod is worse than none: crawlers use it to decide whether to re-fetch).
//
// `buildDate` is read at REQUEST time, so it must be set on the RUNTIME stage of the image — a
// build-stage-only ENV reaches the prerendered HTML and nothing else (see the Dockerfile note).
// Filename carries no `.get` suffix so HEAD is answered too (see robots.txt.ts).

export default defineEventHandler((event) => {
  const config = useRuntimeConfig(event)
  const base = siteBaseUrl(config.public.siteUrl)
  setResponseHeader(event, 'content-type', 'application/xml; charset=utf-8')
  setResponseHeader(event, 'cache-control', 'public, max-age=86400')
  return buildSitemapXml(base, config.public.buildDate)
})
