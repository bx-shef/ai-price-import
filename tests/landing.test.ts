import { describe, expect, it } from 'vitest'
import { canonicalUrl, copyrightYears, LANDING_FEATURES, LANDING_SITE_URL, LANDING_STEPS, LANDING_SUBTITLE, ogImageUrl, siteBaseUrl } from '../app/utils/landing'

describe('landing content', () => {
  it('has 3 how-it-works steps in order and 4 features', () => {
    expect(LANDING_STEPS.map(s => s.n)).toEqual([1, 2, 3])
    expect(LANDING_FEATURES).toHaveLength(4)
    expect(LANDING_SUBTITLE).toMatch(/1-в-1/)
  })
})

describe('siteBaseUrl', () => {
  it('uses the configured deployment URL, normalised to scheme+host+port', () => {
    expect(siteBaseUrl('https://staging.example.com')).toBe('https://staging.example.com')
    expect(siteBaseUrl('https://staging.example.com///')).toBe('https://staging.example.com')
    expect(siteBaseUrl('http://localhost:3000')).toBe('http://localhost:3000')
    expect(siteBaseUrl('HTTPS://Example.COM')).toBe('https://example.com') // scheme/host case
  })

  // The whole point of the helper: an unset/relative/garbage value must NEVER yield a relative base,
  // because the landing is prerendered and a relative og:image is dropped by Facebook/LinkedIn.
  it('falls back to the canonical landing home for anything not absolute', () => {
    for (const v of [undefined, null, '', '   ', '/', 'price-import.bx-shef.by', '//evil.test', 'ftp://x.test', 'https://', 'javascript:alert(1)']) {
      expect(siteBaseUrl(v)).toBe(LANDING_SITE_URL)
    }
  })

  // The base is interpolated into a LINE-oriented file (robots.txt) and into MARKUP (sitemap <loc>).
  // A prefix-only check let all of these through; each produced a silently wrong artefact.
  it('rejects userinfo confusion', () => {
    expect(siteBaseUrl('https://price-import.bx-shef.by@attacker.example')).toBe(LANDING_SITE_URL)
    expect(siteBaseUrl('https://user:pass@host.test')).toBe(LANDING_SITE_URL)
    expect(siteBaseUrl('https://x.test Allow: /')).toBe(LANDING_SITE_URL) // space is a forbidden host char
  })

  // `new URL` does NOT reject CR/LF/TAB — WHATWG STRIPS them before parsing, so some of these parse
  // fine. What guarantees no directive can be injected into the line-oriented robots.txt is returning
  // `.origin`, nothing else. Assert that invariant rather than the rejection it isn't.
  it('never yields a base carrying CR/LF/TAB', () => {
    for (const v of ['https://x.test\nDisallow: /', 'https://x.test\nAllow', 'https://x.test\r\n', 'https://x.test\tx']) {
      expect(siteBaseUrl(v)).not.toMatch(/[\n\r\t]/)
    }
  })

  // A base carrying a path/query/fragment made og:image resolve to the HTML page, not the picture.
  it('drops path, query and fragment', () => {
    expect(siteBaseUrl('https://x.test/sub')).toBe('https://x.test')
    expect(siteBaseUrl('https://x.test?utm=1')).toBe('https://x.test')
    expect(siteBaseUrl('https://x.test#frag')).toBe('https://x.test')
  })
})

describe('ogImageUrl', () => {
  it('is always absolute', () => {
    // Хелпер по-прежнему принимает базу (его зовут краулерные файлы); сам лендинг с #304
    // вызывает его БЕЗ аргумента — canonical/OG всегда прод.
    expect(ogImageUrl('https://staging.example.com')).toBe('https://staging.example.com/og.png')
    expect(ogImageUrl('')).toBe(`${LANDING_SITE_URL}/og.png`)
    expect(ogImageUrl(undefined)).toMatch(/^https:\/\/.+\/og\.png$/)
  })
})

describe('canonicalUrl', () => {
  it('builds an absolute URL without duplicating slashes', () => {
    expect(canonicalUrl('/', 'https://x.test')).toBe('https://x.test/')
    expect(canonicalUrl('', 'https://x.test')).toBe('https://x.test/')
    expect(canonicalUrl('/app', 'https://x.test')).toBe('https://x.test/app')
    expect(canonicalUrl('//app', 'https://x.test')).toBe('https://x.test/app')
    expect(canonicalUrl('/')).toBe(`${LANDING_SITE_URL}/`)
  })

  // `path` is root-relative by contract; an absolute one would otherwise be appended to the base.
  it('never lets an absolute path smuggle in another host', () => {
    expect(canonicalUrl('https://evil.tld/x', 'https://x.test')).toBe('https://x.test/')
    expect(canonicalUrl('javascript:alert(1)', 'https://x.test')).toBe('https://x.test/')
  })
})

describe('copyrightYears', () => {
  it('single year when same, range otherwise', () => {
    expect(copyrightYears(2026, 2026)).toBe('2026')
    expect(copyrightYears(2024, 2026)).toBe('2024–2026')
    expect(copyrightYears(2027, 2026)).toBe('2026') // clamp future start
  })
})
