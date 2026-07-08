import { describe, expect, it } from 'vitest'
import { buildFrameHeaders, fetchErrorMessage } from '../app/utils/frameHeaders'

describe('buildFrameHeaders', () => {
  it('builds the exact headers extractFrameAuth parses, or null', () => {
    expect(buildFrameHeaders({ accessToken: 'tok', domain: 'p.bitrix24.by' }))
      .toEqual({ 'Authorization': 'Bearer tok', 'X-B24-Domain': 'p.bitrix24.by' })
    expect(buildFrameHeaders(null)).toBeNull()
  })
})

describe('fetchErrorMessage', () => {
  it('surfaces the server {error} body, else the fallback', () => {
    expect(fetchErrorMessage({ data: { error: 'файл слишком большой' } }, 'fb')).toBe('файл слишком большой')
    expect(fetchErrorMessage({ data: {} }, 'fb')).toBe('fb')
    expect(fetchErrorMessage({ data: { error: '   ' } }, 'fb')).toBe('fb') // blank → fallback
    expect(fetchErrorMessage(new Error('boom'), 'fb')).toBe('fb')
    expect(fetchErrorMessage(null, 'fb')).toBe('fb')
  })
})
