import { describe, expect, it } from 'vitest'
import { healthInfo } from '../app/utils/build'

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
