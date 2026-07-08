import { describe, expect, it } from 'vitest'
import { extractFrameAuth } from '../server/utils/frameAuth'

describe('extractFrameAuth', () => {
  it('extracts Bearer token + domain', () => {
    expect(extractFrameAuth({ 'authorization': 'Bearer tok123', 'x-b24-domain': 'p.bitrix24.ru' }))
      .toEqual({ accessToken: 'tok123', domain: 'p.bitrix24.ru' })
  })
  it('null on missing token or domain', () => {
    expect(extractFrameAuth({ 'x-b24-domain': 'p.bitrix24.ru' })).toBeNull()
    expect(extractFrameAuth({ authorization: 'Bearer t' })).toBeNull()
    expect(extractFrameAuth({ 'authorization': 'Basic xxx', 'x-b24-domain': 'p.bitrix24.ru' })).toBeNull()
  })
  it('null on unsafe domain (SSRF guard)', () => {
    expect(extractFrameAuth({ 'authorization': 'Bearer t', 'x-b24-domain': 'evil.com' })).toBeNull()
  })
})
