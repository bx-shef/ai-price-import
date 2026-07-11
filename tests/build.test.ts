import { describe, expect, it } from 'vitest'
import { healthInfo, shortSha, commitUrl } from '../app/utils/build'

describe('healthInfo', () => {
  it('dev commit → no url', () => {
    expect(healthInfo('dev')).toEqual({ status: 'ok', commit: 'dev', commitUrl: null })
    expect(healthInfo(undefined)).toEqual({ status: 'ok', commit: 'dev', commitUrl: null })
  })

  it('real sha → commit url', () => {
    const r = healthInfo('abc123')
    expect(r.commit).toBe('abc123')
    expect(r.commitUrl).toBe('https://github.com/bx-shef/ai-price-import/commit/abc123')
  })
})

describe('shortSha', () => {
  it('truncates a long sha to 7 chars', () => {
    expect(shortSha('0123456789abcdef')).toBe('0123456')
  })
  it('handles dev / empty / nullish', () => {
    expect(shortSha('dev')).toBe('dev')
    expect(shortSha('')).toBe('')
    expect(shortSha(undefined)).toBe('')
    expect(shortSha(null)).toBe('')
  })
})

describe('commitUrl', () => {
  it('real sha → commit link', () => {
    expect(commitUrl('abc1234')).toBe('https://github.com/bx-shef/ai-price-import/commit/abc1234')
  })
  it('dev / empty / nullish → repo root', () => {
    const root = 'https://github.com/bx-shef/ai-price-import'
    expect(commitUrl('dev')).toBe(root)
    expect(commitUrl('')).toBe(root)
    expect(commitUrl(undefined)).toBe(root)
  })
})
