import { siteBaseUrl } from '~/utils/landing'
import { buildSitemapXml } from '../utils/seoFiles'

// GET /sitemap.xml — one entry, the landing (the only indexable page; see seoFiles). `lastmod` is the
// deploy date, taken from the build stamp rather than `now` so repeated fetches of an unchanged
// deployment report an unchanged date. No build date configured → the element is omitted (a wrong
// lastmod is worse than none: crawlers use it to decide whether to re-fetch).

export default defineEventHandler((event) => {
  const config = useRuntimeConfig(event)
  const base = siteBaseUrl(config.public.siteUrl as string)
  setResponseHeader(event, 'content-type', 'application/xml; charset=utf-8')
  setResponseHeader(event, 'cache-control', 'public, max-age=86400')
  return buildSitemapXml(base, config.public.buildDate as string)
})
