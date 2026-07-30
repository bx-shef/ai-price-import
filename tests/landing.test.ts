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
  it('uses the configured deployment URL, trimming trailing slashes', () => {
    expect(siteBaseUrl('https://staging.example.com')).toBe('https://staging.example.com')
    expect(siteBaseUrl('https://staging.example.com///')).toBe('https://staging.example.com')
    expect(siteBaseUrl('http://localhost:3000')).toBe('http://localhost:3000')
  })

  // The whole point of the helper: an unset/relative/garbage value must NEVER yield a relative base,
  // because the landing is prerendered and a relative og:image is dropped by Facebook/LinkedIn.
  it('falls back to the canonical landing home for anything not absolute', () => {
    for (const v of [undefined, null, '', '   ', '/', 'price-import.bx-shef.by', '//evil.test', 'ftp://x.test']) {
      expect(siteBaseUrl(v)).toBe(LANDING_SITE_URL)
    }
  })
})

describe('ogImageUrl', () => {
  it('is always absolute', () => {
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
})

describe('copyrightYears', () => {
  it('single year when same, range otherwise', () => {
    expect(copyrightYears(2026, 2026)).toBe('2026')
    expect(copyrightYears(2024, 2026)).toBe('2024–2026')
    expect(copyrightYears(2027, 2026)).toBe('2026') // clamp future start
  })
})
