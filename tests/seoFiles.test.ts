import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildRobotsTxt, buildSitemapXml, DISALLOWED_PATHS } from '../server/utils/seoFiles'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8')

describe('buildRobotsTxt', () => {
  const txt = buildRobotsTxt('https://x.test')

  it('closes /api/ and points at an ABSOLUTE sitemap', () => {
    expect(txt.startsWith('User-agent: *')).toBe(true)
    expect(txt).toContain('Disallow: /api/')
    expect(txt).toContain('Sitemap: https://x.test/sitemap.xml')
  })

  // Disallow and noindex are ALTERNATIVES: a blocked page is never fetched, so its noindex is never
  // read and the bare URL can still be listed. The in-portal pages rely on noindex, so they must stay
  // crawlable — this pins the decision so a well-meaning «let's also block them» reverts it.
  it('does NOT block the pages that rely on robots:noindex', () => {
    for (const p of ['/app', '/settings', '/metrics', '/install', '/import', '/login', '/queues']) {
      expect(txt).not.toContain(`Disallow: ${p}`)
    }
    expect(DISALLOWED_PATHS).toEqual(['/api/'])
  })
})

describe('buildSitemapXml', () => {
  it('lists the landing only, with an absolute loc', () => {
    const xml = buildSitemapXml('https://x.test')
    expect(xml).toContain('<loc>https://x.test/</loc>')
    expect(xml.match(/<url>/g)).toHaveLength(1)
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
  })

  // A raw `&` (an ordinary query string) makes the document non-well-formed and crawlers reject the
  // WHOLE sitemap, not just the entry — so escape at the sink, independently of the source validator.
  it('XML-escapes the base URL', () => {
    const xml = buildSitemapXml('https://x.test/?a=1&b=2')
    expect(xml).toContain('<loc>https://x.test/?a=1&amp;b=2/</loc>')
    expect(xml).not.toMatch(/<loc>[^<]*&(?!amp;|lt;|gt;|quot;|apos;)/)
  })

  it('includes lastmod only for a REAL calendar date', () => {
    expect(buildSitemapXml('https://x.test', '2026-07-29')).toContain('<lastmod>2026-07-29</lastmod>')
    // Shape-valid but impossible dates are rejected by the official sitemap schema (tLastmod = xsd:date).
    for (const bad of [undefined, '', 'today', '2026-7-9', '2026-13-45', '2026-02-30', '2025-02-29', '2026-07-29T10:00:00Z']) {
      expect(buildSitemapXml('https://x.test', bad)).not.toContain('<lastmod>')
    }
  })
})

// Source-derived guards. These read the real files rather than mirroring a list, so they fail on the
// drift they describe instead of merely detecting that someone edited a constant.
describe('crawler policy is wired to the actual pages', () => {
  const prerendered: string[] = [...read('nuxt.config.ts').matchAll(/'(\/[a-z-]*)'/g)]
    .map(m => m[1]!)
    .filter((p, i, a) => a.indexOf(p) === i)

  const noindexPages = readdirSync(resolve(ROOT, 'app/pages'))
    .filter(f => f.endsWith('.vue'))
    .filter(f => /name:\s*'robots'[\s\S]{0,40}content:\s*'noindex'/.test(read(`app/pages/${f}`)))
    .map(f => '/' + f.replace(/\.vue$/, '').replace(/^index$/, ''))
    .sort()

  // Every prerendered page EXCEPT the landing is an in-portal/operator shell whose body is ClientOnly:
  // served publicly, renders empty for a crawler. Adding such a page without `noindex` puts an empty
  // page on the landing's domain — which is exactly what happened before #292.
  it('every prerendered page except the landing carries robots:noindex', () => {
    const shouldBeNoindex = prerendered.filter(p => p !== '/').sort()
    expect(shouldBeNoindex.length).toBeGreaterThan(0)
    expect(noindexPages).toEqual(shouldBeNoindex)
  })

  // The regression #292 fixed: root-level SEO meta applied the landing's marketing OG to /app and
  // /settings. Nothing else would catch its return — the Dockerfile guard only checks that og:image
  // is absolute, which stays true if the meta moves back up.
  it('root app.vue carries no SEO/share meta (it would leak onto every in-portal page)', () => {
    // Comments are stripped first — app.vue explains WHY the meta is not here, and naming the thing
    // it must not contain is exactly what that comment is for.
    const code = read('app/app.vue').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/useSeoMeta\s*\(|ogImage|ogTitle|twitterCard/)
  })
})
