import { isCanonicalHost, siteBaseUrl } from '~/utils/landing'

// Pure builders for the two crawler files (/robots.txt, /sitemap.xml). Served by thin Nitro routes
// rather than shipped as static `public/` files, because both must carry an ABSOLUTE base URL and the
// deployment host varies (prod landing vs a Vibecode target) — a static file would hardcode one host.
//
// `crawlerFiles` below owns the WHOLE composition (raw env → validated base → both bodies) so the
// routes have no logic to get wrong and the tests exercise the shipped seam. Testing `siteBaseUrl` and
// the builders separately left the join untested: a route passing the raw `siteUrl` straight to a
// builder kept every test green while robots.txt became injectable again.

/**
 * Paths closed to crawlers. **Only `/api/`** — deliberately NOT the in-portal pages.
 *
 * `Disallow` and `noindex` are alternatives, not layers: a crawler that obeys `Disallow` never fetches
 * the page, so it never sees the `noindex` and may still list the bare URL. Since `/app`, `/settings`,
 * `/metrics`, `/install`, `/import`, `/login` and `/queues` are prerendered, return 200 and carry
 * `<meta name="robots" content="noindex">`, letting crawlers READ them is what actually keeps them out
 * of the index. Cheap either way: `/app`, `/settings` and `/metrics` render an empty body (`ClientOnly`),
 * the rest a thin static shell. `/api/` is the opposite case — no HTML, nothing that could carry a meta
 * tag — so there the crawl-level block is the only available mechanism.
 *
 * NB `Disallow` matches by PREFIX, so `/api/` is narrower than the old `/app` entry — inert static
 * assets under those prefixes (the hint GIF, the prerendered `_payload.json` stubs) are crawlable.
 * Closing those properly needs an `X-Robots-Tag` header, not a `Disallow`.
 */
export const DISALLOWED_PATHS = ['/api/'] as const

/** `robots.txt` body. No `Allow:` line — an unlisted path is allowed by default, and its position
 *  relative to the `Disallow` group changes matching under first-match-wins parsers.
 *
 *  A NON-CANONICAL host (#304: staging, Vibecode, a client's isolated server) omits the `Sitemap:`
 *  line — a duplicate must not invite crawlers. It is NOT `Disallow: /` on purpose: a blocked page
 *  is never fetched, so its canonical tag (which now always points at production) would never be
 *  read, and the bare staging URL could linger in the index — the same «Disallow и noindex —
 *  альтернативы» reasoning as DISALLOWED_PATHS above, applied host-wide. */
export function buildRobotsTxt(baseUrl: string, canonicalHost = true): string {
  return [
    'User-agent: *',
    ...DISALLOWED_PATHS.map(p => `Disallow: ${p}`),
    ...(canonicalHost ? ['', `Sitemap: ${baseUrl}/sitemap.xml`] : []),
    ''
  ].join('\n')
}

/** Escape the five XML predefined entities. The base URL is interpolated into `<loc>`, and a single
 *  raw `&` (an ordinary query string) makes the whole document non-well-formed — crawlers then reject
 *  the sitemap outright rather than skipping one entry. Escaping at the SINK, so this holds regardless
 *  of what the source validator lets through. */
function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/** True for a real calendar date in `YYYY-MM-DD`. A shape-only regex accepts `2026-13-45`, which the
 *  official sitemap schema rejects (`tLastmod` = `xsd:date`|`xsd:dateTime`) — the round-trip through
 *  `Date` is what makes «a wrong lastmod is worse than none» actually hold. */
function isCalendarDate(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false
  const parsed = new Date(`${d}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== d) return false
  return parsed.getUTCFullYear() > 0 // `Date` accepts year 0000; XSD 1.0 `xsd:date` does not
}

/** `sitemap.xml` body. One entry — the landing is the only indexable page (see `DISALLOWED_PATHS`).
 *  `lastmod` is injected (build date) so the file stays deterministic and testable; an absent or
 *  malformed date omits the element rather than emitting an invalid one. */
export function buildSitemapXml(baseUrl: string, lastmod?: string, canonicalHost = true): string {
  const iso = lastmod && isCalendarDate(lastmod) ? lastmod : undefined
  // A duplicate host serves a VALID but EMPTY sitemap (#304): well-formed (crawlers that fetched it
  // anyway don't error), advertising nothing.
  if (!canonicalHost) {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      '</urlset>',
      ''
    ].join('\n')
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    '  <url>',
    `    <loc>${xmlEscape(baseUrl)}/</loc>`,
    ...(iso ? [`    <lastmod>${iso}</lastmod>`] : []),
    '    <changefreq>weekly</changefreq>',
    '    <priority>1.0</priority>',
    '  </url>',
    '</urlset>',
    ''
  ].join('\n')
}

/** Both crawler files from the RAW configured site URL. The single entry point the routes use — the
 *  validation (`siteBaseUrl`) and the rendering are joined here, once, instead of in each route. */
export function crawlerFiles(siteUrl: string | undefined | null, buildDate?: string): { robots: string, sitemap: string } {
  const base = siteBaseUrl(siteUrl)
  const canonical = isCanonicalHost(siteUrl)
  return { robots: buildRobotsTxt(base, canonical), sitemap: buildSitemapXml(base, buildDate, canonical) }
}
