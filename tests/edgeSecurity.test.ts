import { describe, expect, it } from 'vitest'
import {
  EDGE_MAX_BODY_BYTES,
  LOGIN_MAX_ATTEMPTS,
  LOGIN_WINDOW_MS,
  bodySizeStatus,
  buildSecurityHeaders,
  contentSecurityPolicy,
  edgeBodyGuard,
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

describe('bodySizeStatus', () => {
  const MAX = 1000
  it('413 when declared length exceeds max, regardless of topology (defense in depth)', () => {
    expect(bodySizeStatus(false, MAX + 1, MAX)).toBe(413)
    expect(bodySizeStatus(true, MAX + 1, MAX)).toBe(413)
  })
  it('edge ON: missing/zero Content-Length → 411 (chunked would buffer unbounded)', () => {
    expect(bodySizeStatus(true, 0, MAX)).toBe(411)
    expect(bodySizeStatus(true, Number.NaN, MAX)).toBe(411)
  })
  it('edge OFF: missing Content-Length is allowed (nginx caps it)', () => {
    expect(bodySizeStatus(false, 0, MAX)).toBeNull()
  })
  it('within-limit declared length → null (ok) in both topologies', () => {
    expect(bodySizeStatus(true, MAX, MAX)).toBeNull()
    expect(bodySizeStatus(false, 500, MAX)).toBeNull()
  })
  it('EDGE_MAX_BODY_BYTES mirrors nginx client_max_body_size (25 MB)', () => {
    expect(EDGE_MAX_BODY_BYTES).toBe(25 * 1024 * 1024)
  })
})

describe('edgeBodyGuard (global middleware guard)', () => {
  const MAX = 1000
  it('413 when declared Content-Length exceeds max', () => {
    expect(edgeBodyGuard('1001', undefined, MAX)).toBe(413)
  })
  it('411 for a chunked body with NO Content-Length (unbounded buffer)', () => {
    expect(edgeBodyGuard(undefined, 'chunked', MAX)).toBe(411)
    expect(edgeBodyGuard(undefined, 'gzip, chunked', MAX)).toBe(411)
    expect(edgeBodyGuard(undefined, 'CHUNKED', MAX)).toBe(411)
  })
  it('does NOT reject a bodyless / Content-Length:0 request (no header, no chunked)', () => {
    expect(edgeBodyGuard(undefined, undefined, MAX)).toBeNull()
    expect(edgeBodyGuard('0', undefined, MAX)).toBeNull()
  })
  it('chunked WITH a Content-Length → not 411 (length present, framed)', () => {
    expect(edgeBodyGuard('500', 'chunked', MAX)).toBeNull()
  })
  it('within-limit declared length → null', () => {
    expect(edgeBodyGuard('999', undefined, MAX)).toBeNull()
  })
})

describe('login throttle constants', () => {
  it('sane budget: 10 attempts / 15 min', () => {
    expect(LOGIN_MAX_ATTEMPTS).toBe(10)
    expect(LOGIN_WINDOW_MS).toBe(15 * 60 * 1000)
  })
})
