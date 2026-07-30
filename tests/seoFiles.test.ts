import { describe, expect, it } from 'vitest'
import { buildRobotsTxt, buildSitemapXml, DISALLOWED_PATHS } from '../server/utils/seoFiles'

describe('buildRobotsTxt', () => {
  const txt = buildRobotsTxt('https://x.test')

  it('closes every service path and points at an ABSOLUTE sitemap', () => {
    for (const p of DISALLOWED_PATHS) expect(txt).toContain(`Disallow: ${p}`)
    expect(txt).toContain('Sitemap: https://x.test/sitemap.xml')
    expect(txt.startsWith('User-agent: *')).toBe(true)
  })

  // The meta tags and the crawl file are two halves of one policy; a page that gains `noindex`
  // without a Disallow (or vice versa) means one of the two was forgotten.
  it('covers the same set as the pages carrying robots:noindex', () => {
    expect([...DISALLOWED_PATHS].sort()).toEqual(
      ['/api/', '/app', '/import', '/install', '/login', '/metrics', '/queues', '/settings']
    )
  })
})

describe('buildSitemapXml', () => {
  it('lists the landing only, with an absolute loc', () => {
    const xml = buildSitemapXml('https://x.test')
    expect(xml).toContain('<loc>https://x.test/</loc>')
    expect(xml.match(/<url>/g)).toHaveLength(1)
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
  })

  it('includes lastmod only for a well-formed date', () => {
    expect(buildSitemapXml('https://x.test', '2026-07-29')).toContain('<lastmod>2026-07-29</lastmod>')
    // A wrong lastmod is worse than none — crawlers use it to decide whether to re-fetch.
    for (const bad of [undefined, '', 'today', '2026-7-9', '2026-07-29T10:00:00Z']) {
      expect(buildSitemapXml('https://x.test', bad)).not.toContain('<lastmod>')
    }
  })
})
