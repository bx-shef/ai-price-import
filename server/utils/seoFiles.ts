// Pure builders for the two crawler files (/robots.txt, /sitemap.xml). Served by thin Nitro routes
// rather than shipped as static `public/` files, because both must carry an ABSOLUTE base URL and the
// deployment host varies (prod landing vs a Vibecode target) — a static file would hardcode one host.

/**
 * Paths closed to crawlers. **Only `/api/`** — deliberately NOT the in-portal pages.
 *
 * `Disallow` and `noindex` are alternatives, not layers: a crawler that obeys `Disallow` never fetches
 * the page, so it never sees the `noindex` and may still list the bare URL. Since `/app`, `/settings`,
 * `/metrics`, `/install`, `/import`, `/login` and `/queues` are prerendered, return 200 and carry
 * `<meta name="robots" content="noindex">`, letting crawlers READ them is what actually keeps them out
 * of the index — their bodies are `ClientOnly`, so crawling costs nothing. `/api/` is the opposite
 * case: no HTML, nothing that could carry a meta tag, so the crawl-level block is the only mechanism.
 */
export const DISALLOWED_PATHS = ['/api/'] as const

/** `robots.txt` body. No `Allow:` line — an unlisted path is allowed by default, and its position
 *  relative to the `Disallow` group changes matching under first-match-wins parsers. */
export function buildRobotsTxt(baseUrl: string): string {
  return [
    'User-agent: *',
    ...DISALLOWED_PATHS.map(p => `Disallow: ${p}`),
    '',
    `Sitemap: ${baseUrl}/sitemap.xml`,
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
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === d
}

/** `sitemap.xml` body. One entry — the landing is the only indexable page (see `DISALLOWED_PATHS`).
 *  `lastmod` is injected (build date) so the file stays deterministic and testable; an absent or
 *  malformed date omits the element rather than emitting an invalid one. */
export function buildSitemapXml(baseUrl: string, lastmod?: string): string {
  const iso = lastmod && isCalendarDate(lastmod) ? lastmod : undefined
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
