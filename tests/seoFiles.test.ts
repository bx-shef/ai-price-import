import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { buildRobotsTxt, buildSitemapXml, crawlerFiles, DISALLOWED_PATHS } from '../server/utils/seoFiles'
import { CRAWLER_ALLOWED_METHODS, crawlerMethodGate } from '../server/utils/crawlerRoute'

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
  it('lists the landing and the four legal documents, with absolute locs', () => {
    // Три адреса, а не один (#297): лицензия и политика обязаны быть публичными по требованию
    // Маркета. Число закреплено намеренно — «заодно» добавленная служебная страница краснеет.
    const xml = buildSitemapXml('https://x.test')
    expect(xml).toContain('<loc>https://x.test/</loc>')
    expect(xml.match(/<url>/g)).toHaveLength(5)
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

// ── Source-derived guards ─────────────────────────────────────────────────────────────────────────
// Two earlier versions of this block were unsound: the first compared a constant to a copy of itself,
// the second parsed `nuxt.config.ts` with a regex and was blind to four of Nuxt's prerender
// mechanisms. Both lessons are baked in below: the invariant is stated over PAGES (not over a config
// literal), and every extraction asserts it found something before asserting about it.

/** Strip comments and `definePageMeta` before matching. A commented-out `useHead`, a block comment and
 *  a route-meta key all read as «noindex» to a raw-source scan but emit no tag at all. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ') // keep `https://`
    .replace(/\bdefinePageMeta\s*\([\s\S]*?\)\s*$/gm, ' ')
}

/** True when the source actually EMITS `<meta name=robots content=…noindex…>`. Anchored to an object
 *  literal so the word in prose or a UI string cannot satisfy it; `property:` is NOT accepted (crawlers
 *  read `name=`); `robots: 'none'` counts — Google documents it as noindex+nofollow. */
const NOINDEX_VALUE = String.raw`(?:[^'"]*\bnoindex\b[^'"]*|\s*none\s*)`
function emitsNoindex(src: string): boolean {
  const c = codeOnly(src)
  return new RegExp(String.raw`\{[^{}]*\brobots\s*:\s*(['"])${NOINDEX_VALUE}\1`).test(c)
    || new RegExp(String.raw`\{[^{}]*\bname\s*:\s*(['"])robots\1[^{}]*\bcontent\s*:\s*(['"])${NOINDEX_VALUE}\2[^{}]*\}`).test(c)
    || new RegExp(String.raw`\{[^{}]*\bcontent\s*:\s*(['"])${NOINDEX_VALUE}\1[^{}]*\bname\s*:\s*(['"])robots\2[^{}]*\}`).test(c)
}

/** Every page file, recursively (nested dirs, `[id].vue`, `.client.vue` — all reachable routes). */
function pageFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
    if (e.isDirectory()) pageFiles(`${dir}/${e.name}`, acc)
    else if (e.name.endsWith('.vue')) acc.push(`${dir}/${e.name}`)
  }
  return acc
}

describe('индексируется только лендинг', () => {
  // Stated over PAGES, not over `nitro.prerender.routes`: Nuxt has four ways to prerender (the routes
  // array, `routeRules`, crawlLinks, `pnpm generate`) and under the `node-server` preset every page is
  // SSR'd and publicly reachable anyway. Enumerating pages has no false negatives across all of them.
  // Исключение появилось осознанно (#297): Маркет Bitrix24 требует лицензию и политику по
  // постоянным публичным адресам, а закрытый от индексации юридический документ — худший ответ
  // модератору, чем открытый. Список ИМЕНОВАННЫЙ: новая страница по умолчанию по-прежнему обязана
  // нести noindex, иначе служебный экран однажды уедет в выдачу вместе с пустым телом.
  const INDEXABLE = ['app/pages/index.vue', 'app/pages/eula.vue', 'app/pages/privacy.vue',
    'app/pages/site-terms.vue', 'app/pages/site-privacy.vue']

  it('индексируются только лендинг и юридические документы', () => {
    const files = pageFiles('app/pages')
    expect(files.length).toBeGreaterThan(1)
    for (const f of files) {
      const indexable = INDEXABLE.includes(f)
      expect(emitsNoindex(read(f)), `${f}: ожидалось ${indexable ? 'БЕЗ noindex (страница публичная)' : 'robots:noindex'}`)
        .toBe(!indexable)
    }
  })

  it('юридические страницы существуют и попали в sitemap', () => {
    // Обратная половина: удалить страницу и оставить исключение — значит тихо потерять требование
    // Маркета. Проверяем и файл, и то, что адрес реально объявлен краулерам.
    for (const f of ['app/pages/eula.vue', 'app/pages/privacy.vue', 'app/pages/site-terms.vue', 'app/pages/site-privacy.vue']) {
      expect(existsSync(resolve(ROOT, f)), `${f} должна существовать`).toBe(true)
    }
    const sitemap = buildSitemapXml('https://example.test', '2026-08-02')
    expect(sitemap).toContain('<loc>https://example.test/eula</loc>')
    expect(sitemap).toContain('<loc>https://example.test/privacy</loc>')
    expect(sitemap).toContain('<loc>https://example.test/site-terms</loc>')
    expect(sitemap).toContain('<loc>https://example.test/site-privacy</loc>')
  })

  // The #292 regression: SEO meta in a component that wraps MANY pages applied the landing's marketing
  // OG to /app and /settings. `app.vue` is not the only such place — a layout wraps six pages, and
  // `nuxt.config`'s `app.head` wraps everything, so all three are checked. Matched by CODE SHAPE, so
  // prose cannot trip it and `useHead({meta:[{property:'og:image'}]})` cannot slip past.
  it('обёртки нескольких страниц не несут SEO-меты', () => {
    const wrappers = ['app/app.vue', ...readdirSync(resolve(ROOT, 'app/layouts')).map(f => `app/layouts/${f}`)]
    expect(wrappers.length).toBeGreaterThan(1)
    for (const f of wrappers) {
      const code = codeOnly(read(f))
      expect(code, `${f}`).not.toMatch(/\buse(Server)?SeoMeta\s*\(/)
      expect(code, `${f}`).not.toMatch(/['"](og|twitter):[a-z]/i)
      expect(code, `${f}`).not.toMatch(/name\s*:\s*['"]description['"]/)
    }
    // nuxt.config's app.head is global — the same leak, one level up.
    const head = read('nuxt.config.ts').match(/head:\s*\{[\s\S]*?\n {4}\}/)?.[0] ?? ''
    expect(head).toContain('link') // the block exists — otherwise this guard silently checks nothing
    expect(head).not.toMatch(/['"](og|twitter):|name\s*:\s*['"]description['"]/i)
  })

  // Denylist above needs a symmetric half: deleting the landing's meta outright would keep everything
  // green while shipping a landing with no share card. Pins the WIRING, not just the identifier —
  // `const ogImage = '/og.png'` is the literal #292 defect and must not satisfy it.
  it('лендинг сохраняет свою SEO-мету и строит og:image абсолютным', () => {
    const landing = read('app/pages/index.vue')
    expect(landing).toMatch(/useSeoMeta\s*\(/)
    expect(landing).toMatch(/const ogImage = ogImageUrl\(/)
    expect(landing).toMatch(/\bogImage,/)
    expect(landing).toMatch(/twitterCard:\s*['"]summary_large_image['"]/)
    expect(landing).toMatch(/rel:\s*['"]canonical['"]/)
  })
})

describe('краулерные роуты', () => {
  // `foo.get.ts` is the CONVENTIONAL Nitro naming, so renaming back is natural — and it silently
  // reintroduces `HEAD /robots.txt` → 404. Scoped to the two crawler files: banning the suffix
  // directory-wide would misfire on any future ordinary route.
  it('не несут суффикса метода в имени файла (иначе HEAD → 404)', () => {
    for (const f of ['robots.txt', 'sitemap.xml']) {
      expect(existsSync(resolve(ROOT, `server/routes/${f}.ts`)), `server/routes/${f}.ts должен существовать`).toBe(true)
      expect(existsSync(resolve(ROOT, `server/routes/${f}.get.ts`)), `${f}.get.ts: суффикс делает HEAD 404`).toBe(false)
    }
  })

  // `crawlerFiles` is only the shipped seam if the routes actually go through it. Without this, a
  // route reverting to `buildRobotsTxt(rawSiteUrl)` keeps every other test green while robots.txt
  // becomes injectable again — the exact scenario the composition suite below is meant to cover.
  it('оба роута ходят через crawlerFiles, а не мимо валидации', () => {
    for (const f of ['server/routes/robots.txt.ts', 'server/routes/sitemap.xml.ts']) {
      const src = read(f)
      expect(src, `${f}: композиция должна идти через crawlerFiles`).toMatch(/crawlerFiles\s*\(/)
      expect(src, `${f}: билдеры напрямую — значит siteBaseUrl обойдён`).not.toMatch(/build(RobotsTxt|SitemapXml)\s*\(/)
    }
  })

  // The gate itself, directly — it is the compensating control for the missing suffix, and nothing
  // else stops a refactor from dropping the one-line call from either route.
  it('метод-гард: GET/HEAD обслуживаются, OPTIONS → 204+Allow, остальное → 405+Allow', () => {
    const headers: Record<string, string> = {}
    let status = 200
    vi.stubGlobal('setResponseHeader', (_e: unknown, k: string, v: string) => {
      headers[k] = v
    })
    vi.stubGlobal('setResponseStatus', (_e: unknown, s: number) => {
      status = s
    })
    vi.stubGlobal('createError', (o: { statusCode: number }) => Object.assign(new Error('405'), o))
    try {
      for (const m of ['GET', 'HEAD']) {
        expect(crawlerMethodGate({ method: m } as never)).toBe('handle')
      }
      expect(crawlerMethodGate({ method: 'OPTIONS' } as never)).toBe('no-content')
      expect(status).toBe(204)
      expect(headers.allow).toBe(CRAWLER_ALLOWED_METHODS)
      for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'TRACE']) {
        // RFC 9110 §15.5.6 makes `Allow` a MUST on 405 — and «405 without Allow» is the same scanner
        // finding this gate exists to remove.
        expect(() => crawlerMethodGate({ method: m } as never), m).toThrowError(expect.objectContaining({ statusCode: 405 }))
        expect(headers.allow).toBe(CRAWLER_ALLOWED_METHODS)
      }
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// The composition, through the SHIPPED entry point — `crawlerFiles` is what both routes call, so a
// route can no longer bypass validation without this failing. Testing `siteBaseUrl` and the builders
// separately left exactly that join uncovered.
describe('враждебный NUXT_PUBLIC_SITE_URL не доходит до краулерных файлов', () => {
  const hostile = [
    'https://price-import.bx-shef.by\nDisallow: /',
    'https://price-import.bx-shef.by\nAllow',
    'https://price-import.bx-shef.by@attacker.example',
    'https://a&b.test',
    'https://x.test/?a=1&b=2',
    'javascript:alert(1)',
    '//evil.test',
    '',
    undefined
  ]

  it('robots.txt не получает лишних директив', () => {
    for (const raw of hostile) {
      const lines = crawlerFiles(raw).robots.split('\n').filter(l => /^[A-Za-z-]+:/.test(l))
      // Either the canonical form (User-agent + Disallow + Sitemap) or the closed form for a
      // non-canonical host (User-agent + Disallow) — never anything smuggled in on top.
      expect(lines.length, `база ${JSON.stringify(raw)} → ${JSON.stringify(lines)}`).toBeLessThanOrEqual(3)
      expect(lines.filter(l => l.startsWith('Sitemap:')).length).toBeLessThanOrEqual(1)
      expect(lines.every(l => /^(User-agent|Disallow|Sitemap):/.test(l))).toBe(true)
    }
  })

  it('sitemap остаётся well-formed', () => {
    for (const raw of hostile) {
      // С #304 враждебная база может отвалидироваться в НЕканонический origin — тогда sitemap
      // валидный и пустой (<loc> нет вовсе). Если <loc> есть, он обязан быть чистым.
      const sitemap = crawlerFiles(raw, '2026-07-31').sitemap
      expect(sitemap, `база ${JSON.stringify(raw)}`).toContain('<urlset')
      const loc = sitemap.match(/<loc>([\s\S]*?)<\/loc>/)?.[1]
      if (loc === undefined) continue
      expect(loc, `база ${JSON.stringify(raw)}`).not.toMatch(/[<>]/)
      expect(loc).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/)
      expect(loc).not.toMatch(/[\n\r\t]/)
    }
  })
})

describe('неканонический хост не зовёт себя в индекс (#304)', () => {
  const STAGING = 'https://staging.example.dev'

  it('isCanonicalHost: прод и пустой env — канонические, чужой origin — нет', async () => {
    const { isCanonicalHost, LANDING_SITE_URL } = await import('../app/utils/landing')
    expect(isCanonicalHost(LANDING_SITE_URL)).toBe(true)
    expect(isCanonicalHost(undefined)).toBe(true) // фолбэк и так на прод
    expect(isCanonicalHost('мусор')).toBe(true) // валидатор откатывает на прод
    expect(isCanonicalHost(STAGING)).toBe(false)
    expect(isCanonicalHost('https://price-import.bx-shef.by/path?q=1')).toBe(true) // origin тот же
  })

  it('robots на staging — без строки Sitemap, но БЕЗ Disallow: / (canonical должен читаться)', () => {
    const { robots } = crawlerFiles(STAGING)
    expect(robots).not.toContain('Sitemap:')
    expect(robots).not.toMatch(/^Disallow: \/$/m)
    expect(robots).toContain('Disallow: /api/')
  })

  it('sitemap на staging — валидный, но пустой', () => {
    const { sitemap } = crawlerFiles(STAGING, '2026-07-31')
    expect(sitemap).toContain('<urlset')
    expect(sitemap).not.toContain('<loc>')
    expect(sitemap).not.toContain(STAGING)
  })

  it('прод отдаёт всё как раньше', () => {
    const { robots, sitemap } = crawlerFiles('https://price-import.bx-shef.by', '2026-07-31')
    expect(robots).toContain('Sitemap: https://price-import.bx-shef.by/sitemap.xml')
    expect(sitemap).toContain('<loc>https://price-import.bx-shef.by/</loc>')
  })
})
