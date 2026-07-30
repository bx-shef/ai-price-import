// Pure builders for the two crawler files (/robots.txt, /sitemap.xml). Served by thin Nitro routes
// rather than shipped as static `public/` files, because both must carry an ABSOLUTE base URL and the
// deployment host varies (prod landing vs a Vibecode target) — a static file would hardcode one host.
//
// Crawl policy mirrors the per-page `robots: noindex` meta: the landing is the only public page; every
// in-portal / operator screen is prerendered but renders its body ClientOnly, so a crawler that reached
// one would index an empty page on the landing's domain. Keep the two lists in sync.

/** Paths closed to crawlers — in-portal screens, the operator zone and the API. */
export const DISALLOWED_PATHS = [
  '/app',
  '/settings',
  '/metrics',
  '/install',
  '/import',
  '/login',
  '/queues',
  '/api/'
] as const

/** `robots.txt` body: everything but the service paths, plus the sitemap pointer. */
export function buildRobotsTxt(baseUrl: string): string {
  return [
    'User-agent: *',
    ...DISALLOWED_PATHS.map(p => `Disallow: ${p}`),
    'Allow: /',
    '',
    `Sitemap: ${baseUrl}/sitemap.xml`,
    ''
  ].join('\n')
}

/** `sitemap.xml` body. One entry — the landing is the only indexable page (see the note above).
 *  `lastmod` is injected (build/deploy date) so the file stays deterministic and testable. */
export function buildSitemapXml(baseUrl: string, lastmod?: string): string {
  const iso = lastmod && /^\d{4}-\d{2}-\d{2}$/.test(lastmod) ? lastmod : undefined
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    '  <url>',
    `    <loc>${baseUrl}/</loc>`,
    ...(iso ? [`    <lastmod>${iso}</lastmod>`] : []),
    '    <changefreq>weekly</changefreq>',
    '    <priority>1.0</priority>',
    '  </url>',
    '</urlset>',
    ''
  ].join('\n')
}
