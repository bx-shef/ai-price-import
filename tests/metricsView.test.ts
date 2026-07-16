import { describe, expect, it } from 'vitest'
import { formatRate, summarizeMetrics } from '../app/utils/metricsView'

describe('summarizeMetrics', () => {
  it('orders + labels the known counters, ignores extras', () => {
    const s = summarizeMetrics({ docs: 10, created: 8, lines: 42, unmatched: 1, skipped: 2, errors: 1, bogus: 99 })
    expect(s.rows.map(r => r.key)).toEqual(['docs', 'created', 'lines', 'unmatched', 'skipped', 'errors'])
    expect(s.rows.find(r => r.key === 'lines')?.value).toBe(42)
    expect(s.rows.some(r => r.key === 'bogus')).toBe(false)
    expect(s.rows.find(r => r.key === 'docs')?.label).toBe('Документов обработано')
  })
  it('successRate = created/docs, capped at 1', () => {
    expect(summarizeMetrics({ docs: 10, created: 8 }).successRate).toBe(0.8)
    // created can exceed docs across resets; cap to 1, never >100%.
    expect(summarizeMetrics({ docs: 2, created: 5 }).successRate).toBe(1)
  })
  it('no docs → successRate null (not a fake 0% / NaN) + empty flag', () => {
    const s = summarizeMetrics({})
    expect(s.successRate).toBeNull()
    expect(s.empty).toBe(true)
  })
  it('docs processed but none created → successRate is a real 0, NOT null', () => {
    // The null-vs-0 distinction is the whole point: 0% means «обработали, но ничего не создали».
    const s = summarizeMetrics({ docs: 10, created: 0 })
    expect(s.successRate).toBe(0)
    expect(s.empty).toBe(false)
  })
  it('any positive counter → not empty', () => {
    expect(summarizeMetrics({ errors: 1 }).empty).toBe(false)
  })
  it('coerces bad/negative/absent counters to 0', () => {
    const s = summarizeMetrics({ docs: -5, created: Number.NaN, lines: 3.9 } as unknown as Record<string, number>)
    expect(s.rows.find(r => r.key === 'docs')?.value).toBe(0)
    expect(s.rows.find(r => r.key === 'created')?.value).toBe(0)
    expect(s.rows.find(r => r.key === 'lines')?.value).toBe(3)
  })
  it('null/undefined input → all-zero empty summary', () => {
    expect(summarizeMetrics(null).empty).toBe(true)
    expect(summarizeMetrics(undefined).rows).toHaveLength(6)
  })
})

describe('formatRate', () => {
  it('formats a rate as integer percent, null → dash', () => {
    expect(formatRate(0.8)).toBe('80%')
    expect(formatRate(1)).toBe('100%')
    expect(formatRate(0)).toBe('0%')
    expect(formatRate(null)).toBe('—')
  })
})
