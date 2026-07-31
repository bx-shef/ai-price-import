import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { siteBaseUrl } from '../app/utils/landing'
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
    // `&` in the HOST is the reachable case: it is not a WHATWG forbidden host code point, so it
    // survives `siteBaseUrl` into `<loc>`. (A query cannot — `.origin` strips it.)
    expect(buildSitemapXml('https://a&b.test')).toContain('<loc>https://a&amp;b.test/</loc>')
    expect(buildSitemapXml('https://a&b.test')).not.toMatch(/<loc>[^<]*&(?!amp;|lt;|gt;|quot;|apos;)/)
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
//
// Every extraction below asserts that it FOUND something before asserting about it: a guard that
// silently matches nothing reports success while protecting nothing — the failure mode of both the
// mirrored-list test this replaced and its first source-derived rewrite.

/** Routes from `nitro.prerender.routes`. Anchored to the array: a whole-file scan for `'/…'` also
 *  matched asset paths, and a character class narrower than «any route» silently skipped routes with
 *  digits or a second segment (`/b24-form`) — i.e. exactly the pages that most need checking. */
function prerenderRoutes(): string[] {
  const block = read('nuxt.config.ts').match(/prerender:\s*\{[\s\S]*?routes:\s*\[([\s\S]*?)\]/)
  expect(block, 'nitro.prerender.routes не найден — гард надо чинить, а не игнорировать').toBeTruthy()
  const routes = [...block![1]!.matchAll(/'([^']+)'/g)].map(m => m[1]!)
  expect(routes).toContain('/')
  return routes
}

/** The page file backing a route, or null. Routes → files, not the reverse: a filename-driven scan
 *  cannot see nested pages at all, and mapping `panel.client.vue` back to a route gets it wrong. */
function pageFileFor(route: string): string | null {
  const rel = route === '/' ? 'index' : route.replace(/^\/+/, '')
  for (const c of [`${rel}.vue`, `${rel}/index.vue`, `${rel}.client.vue`, `${rel}.server.vue`]) {
    if (existsSync(resolve(ROOT, 'app/pages', c))) return `app/pages/${c}`
  }
  return null
}

/** Both spellings of «noindex» Nuxt offers, quote- and order-agnostic. Pinning one exact literal made
 *  five equivalent CORRECT rewrites fail — including `useSeoMeta({ robots: 'noindex' })`, the
 *  idiomatic form this very PR uses on the landing. */
function hasNoindex(src: string): boolean {
  return /\brobots\s*:\s*['"][^'"]*noindex/.test(src)
    || (/['"]robots['"]/.test(src) && /content\s*:\s*['"][^'"]*noindex/.test(src))
}

describe('crawler policy is wired to the actual pages', () => {
  // Every prerendered page EXCEPT the landing is publicly reachable but has nothing to offer a
  // crawler (an empty ClientOnly body, or a thin shell). Adding one without `noindex` puts an empty
  // page on the landing's domain — exactly what #292 fixed. ONE-directional on purpose: `noindex` on
  // a page that is NOT prerendered is perfectly correct, and the earlier equality forbade it.
  it('каждая пререндеренная страница кроме лендинга несёт robots:noindex', () => {
    const shells = prerenderRoutes().filter(p => p !== '/')
    expect(shells.length).toBeGreaterThan(0)
    for (const route of shells) {
      const file = pageFileFor(route)
      expect(file, `пререндерится ${route}, но файла страницы нет — гард его не видит`).toBeTruthy()
      expect(hasNoindex(read(file!)), `${file} (пререндерится как ${route}) обязан нести robots:noindex`).toBe(true)
    }
  })

  // The regression #292 fixed: root-level SEO meta applied the landing's marketing OG to /app and
  // /settings. Nothing else would catch its return — the Dockerfile guard only checks that og:image is
  // absolute, which stays true if the meta moves back up. Matched by CODE SHAPE (`key:` / `'og:x'`)
  // rather than by bare word: prose in comments cannot trip it, and `useHead({meta:[{property:
  // 'og:image'}]})` — the likeliest reintroduction, since app.vue already calls useHead — cannot slip
  // past. `useServerSeoMeta` is a distinct name that does NOT contain the substring «useSeoMeta».
  it('корневой app.vue не несёт SEO-меты — иначе она течёт на все in-portal страницы', () => {
    const code = read('app/app.vue')
    expect(code).not.toMatch(/\buse(Server)?SeoMeta\s*\(/)
    expect(code).not.toMatch(/\b(og|twitter)[A-Z]\w*\s*[:,)]/)
    expect(code).not.toMatch(/['"](og|twitter):[a-z]/i)
    expect(code).not.toMatch(/name\s*:\s*['"]description['"]/)
  })

  // Symmetric half: the guard above is a denylist, so deleting the landing's meta outright would keep
  // the whole suite green while shipping a landing with no share card at all.
  it('лендинг по-прежнему несёт свою SEO-мету', () => {
    const landing = read('app/pages/index.vue')
    expect(landing).toMatch(/useSeoMeta\s*\(/)
    expect(landing).toMatch(/ogImage/)
    expect(landing).toMatch(/rel:\s*['"]canonical['"]/)
  })

  // `foo.get.ts` is the CONVENTIONAL Nitro naming, so renaming back is a natural thing for someone to
  // do — and it silently reintroduces `HEAD /robots.txt` → 404, which crawler tooling probes with.
  it('краулерные роуты отвечают на HEAD (в имени файла нет суффикса метода)', () => {
    const files = readdirSync(resolve(ROOT, 'server/routes'))
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      expect(f, `${f}: суффикс .get делает HEAD 404 — краулеры ходят HEAD-ом`).not.toMatch(/\.(get|post|put|patch|delete)\.ts$/)
    }
  })
})

// The hardening lives in `siteBaseUrl`, but the artefacts are built by seoFiles. Testing them apart
// leaves the COMPOSITION untested: pass `config.public.siteUrl` raw to a builder and every helper test
// stays green while robots.txt becomes injectable again.
describe('враждебный NUXT_PUBLIC_SITE_URL не доходит до краулерных файлов', () => {
  const hostile = [
    'https://x.test\nDisallow: /',
    'https://x.test\nAllow',
    'https://price-import.bx-shef.by@attacker.example',
    'https://a&b.test',
    'https://x.test/?a=1&b=2',
    'javascript:alert(1)',
    '//evil.test'
  ]

  it('robots.txt не получает лишних директив', () => {
    for (const raw of hostile) {
      const directives = buildRobotsTxt(siteBaseUrl(raw)).split('\n').filter(l => /^[A-Za-z-]+:/.test(l))
      expect(directives, `база ${JSON.stringify(raw)}`).toHaveLength(3) // User-agent, Disallow, Sitemap
    }
  })

  it('sitemap остаётся well-formed', () => {
    for (const raw of hostile) {
      const xml = buildSitemapXml(siteBaseUrl(raw), '2026-07-31')
      const loc = xml.match(/<loc>([\s\S]*?)<\/loc>/)?.[1]
      expect(loc, `база ${JSON.stringify(raw)}: <loc> не найден`).toBeTruthy()
      // Markup characters must arrive escaped, and a bare `&` (not opening an entity) is what makes
      // the document non-well-formed — crawlers then reject the WHOLE sitemap, not one entry.
      expect(loc, `база ${JSON.stringify(raw)}`).not.toMatch(/[<>]/)
      expect(loc).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/)
      expect(loc).not.toMatch(/[\n\r\t]/)
    }
  })
})
