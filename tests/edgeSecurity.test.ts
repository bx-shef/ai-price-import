import { describe, expect, it } from 'vitest'
import {
  LOGIN_MAX_ATTEMPTS,
  LOGIN_WINDOW_MS,
  buildSecurityHeaders,
  contentSecurityPolicy,
  edgeSecurityEnabled,
  edgeTrustXff,
  normalisePathname,
  rateLimitKey
} from '../server/utils/edgeSecurity'

describe('edgeSecurityEnabled', () => {
  it('off by default / absent / falsey', () => {
    expect(edgeSecurityEnabled({})).toBe(false)
    expect(edgeSecurityEnabled({ APP_EDGE_SECURITY: '' })).toBe(false)
    expect(edgeSecurityEnabled({ APP_EDGE_SECURITY: '0' })).toBe(false)
    expect(edgeSecurityEnabled({ APP_EDGE_SECURITY: 'false' })).toBe(false)
    expect(edgeSecurityEnabled({ APP_EDGE_SECURITY: 'no' })).toBe(false)
  })
  it('on for 1 / true (case-insensitive, trimmed)', () => {
    expect(edgeSecurityEnabled({ APP_EDGE_SECURITY: '1' })).toBe(true)
    expect(edgeSecurityEnabled({ APP_EDGE_SECURITY: 'true' })).toBe(true)
    expect(edgeSecurityEnabled({ APP_EDGE_SECURITY: ' TRUE ' })).toBe(true)
  })
})

describe('contentSecurityPolicy', () => {
  it('strict page CSP for normal paths (frame-ancestors B24, object-src none)', () => {
    const csp = contentSecurityPolicy('/app')
    expect(csp).toContain('default-src \'self\'')
    expect(csp).toContain('object-src \'none\'')
    expect(csp).toContain('frame-ancestors \'self\' https://*.bitrix24.com')
    // strict page CSP must NOT carry the form loader's unsafe-eval
    expect(csp).not.toContain('unsafe-eval')
  })
  it('relaxed form CSP only for /b24-form.html (unsafe-eval + B24 script hosts)', () => {
    const csp = contentSecurityPolicy('/b24-form.html')
    expect(csp).toContain('unsafe-eval')
    expect(csp).toContain('script-src \'self\' \'unsafe-inline\' \'unsafe-eval\' https://*.bitrix24.by')
    expect(csp).toContain('frame-ancestors \'self\'')
  })
})

describe('buildSecurityHeaders', () => {
  it('sets the four hardening headers', () => {
    const h = buildSecurityHeaders('/login')
    expect(h['X-Content-Type-Options']).toBe('nosniff')
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin')
    expect(h['Strict-Transport-Security']).toBe('max-age=63072000; includeSubDomains')
    expect(h['Content-Security-Policy']).toContain('default-src \'self\'')
  })
  it('form path swaps only the CSP', () => {
    expect(buildSecurityHeaders('/b24-form.html')['Content-Security-Policy']).toContain('unsafe-eval')
    expect(buildSecurityHeaders('/b24-form.html')['X-Content-Type-Options']).toBe('nosniff')
  })
})

describe('normalisePathname', () => {
  it('strips query and hash', () => {
    expect(normalisePathname('/b24-form.html?x=1')).toBe('/b24-form.html')
    expect(normalisePathname('/b24-form.html#f')).toBe('/b24-form.html')
    expect(normalisePathname('/app?a=1#b')).toBe('/app')
    expect(normalisePathname('/app')).toBe('/app')
  })
})

describe('edgeTrustXff', () => {
  it('off by default, on for 1/true', () => {
    expect(edgeTrustXff({})).toBe(false)
    expect(edgeTrustXff({ APP_EDGE_TRUST_XFF: '0' })).toBe(false)
    expect(edgeTrustXff({ APP_EDGE_TRUST_XFF: '1' })).toBe(true)
    expect(edgeTrustXff({ APP_EDGE_TRUST_XFF: ' TRUE ' })).toBe(true)
  })
})

describe('rateLimitKey', () => {
  it('edge OFF (behind nginx): trusts the LAST XFF hop (proxy-appended real peer)', () => {
    expect(rateLimitKey(false, false, '1.1.1.1, 2.2.2.2', '10.0.0.1')).toBe('2.2.2.2')
  })
  it('edge ON, trustXff OFF (default, no nginx): ignores spoofable XFF, keys on the real TCP peer', () => {
    expect(rateLimitKey(true, false, '1.1.1.1, 9.9.9.9', '203.0.113.7')).toBe('203.0.113.7')
    // a rotated/forged XFF cannot change the bucket
    expect(rateLimitKey(true, false, 'anything, spoofed', '203.0.113.7')).toBe('203.0.113.7')
  })
  it('edge ON, trustXff ON (verified trusted tunnel): uses the appended last XFF hop', () => {
    expect(rateLimitKey(true, true, '1.1.1.1, 8.8.8.8', '127.0.0.1')).toBe('8.8.8.8')
  })
  it('falls back to "unknown" with no peer', () => {
    expect(rateLimitKey(true, false, undefined, undefined)).toBe('unknown')
    expect(rateLimitKey(false, false, undefined, undefined)).toBe('unknown')
  })
})

describe('login throttle constants', () => {
  it('sane budget: 10 attempts / 15 min', () => {
    expect(LOGIN_MAX_ATTEMPTS).toBe(10)
    expect(LOGIN_WINDOW_MS).toBe(15 * 60 * 1000)
  })
})
