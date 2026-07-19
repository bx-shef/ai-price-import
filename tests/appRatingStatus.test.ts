import { describe, expect, it } from 'vitest'
import { buildRatingStatuses, ratingStateOf } from '../server/utils/appRatingStatus'
import type { RatingStatusRow } from '../server/utils/appRatingStatus'

describe('ratingStateOf', () => {
  it('prioritises reviewed over everything', () => {
    expect(ratingStateOf({ reviewed: true, openedAtMs: 1, promptedAtMs: 1 })).toBe('reviewed')
  })
  it('opened when clicked but not reviewed', () => {
    expect(ratingStateOf({ reviewed: false, openedAtMs: 1, promptedAtMs: 1 })).toBe('opened')
  })
  it('prompted when shown but never opened', () => {
    expect(ratingStateOf({ reviewed: false, openedAtMs: null, promptedAtMs: 1 })).toBe('prompted')
  })
  it('none when nothing happened', () => {
    expect(ratingStateOf({ reviewed: false, openedAtMs: null, promptedAtMs: null })).toBe('none')
  })
})

describe('buildRatingStatuses', () => {
  const row = (o: Partial<RatingStatusRow> & { domain: string }): RatingStatusRow => ({
    memberId: o.domain, domain: o.domain, promptedAtMs: null, openedAtMs: null, reviewed: false, ...o
  })

  it('surfaces «needs attention» first: opened → prompted → none → reviewed', () => {
    const out = buildRatingStatuses([
      row({ domain: 'z-reviewed', reviewed: true }),
      row({ domain: 'a-none' }),
      row({ domain: 'b-opened', openedAtMs: 10 }),
      row({ domain: 'c-prompted', promptedAtMs: 5 })
    ])
    expect(out.map(s => s.state)).toEqual(['opened', 'prompted', 'none', 'reviewed'])
  })

  it('breaks ties within a state by domain', () => {
    const out = buildRatingStatuses([
      row({ domain: 'beta', promptedAtMs: 1 }),
      row({ domain: 'alpha', promptedAtMs: 1 })
    ])
    expect(out.map(s => s.domain)).toEqual(['alpha', 'beta'])
  })
})
