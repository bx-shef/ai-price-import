import { describe, expect, it } from 'vitest'
import { extractFrameAuth } from '../server/utils/frameAuth'
import { isSafeB24Domain } from '../server/utils/b24Rest'

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

describe('isSafeB24Domain — облачные зоны', () => {
  it('принимает одноуровневые зоны и обе официальные двухуровневые (#323)', () => {
    for (const d of ['p.bitrix24.ru', 'p.bitrix24.de', 'p.bitrix24.uk', 'p.bitrix24.com.tr', 'p.bitrix24.com.br']) {
      expect(isSafeB24Domain(d), d).toBe(true)
    }
  })
  it('двухуровневая форма не открывает произвольные суффиксы', () => {
    for (const d of ['p.bitrix24.com.evil', 'p.bitrix24.com.tr.evil.com', 'p.bitrix24.co.uk', 'evil.com']) {
      expect(isSafeB24Domain(d), d).toBe(false)
    }
  })
})
