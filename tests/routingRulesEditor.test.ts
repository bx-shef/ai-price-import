import { describe, expect, it } from 'vitest'
import { parseKeywords, rulesToRows, rowsToRules } from '../app/utils/routingRulesEditor'
import type { RoutingRule } from '../app/types/mapping'

describe('parseKeywords', () => {
  it('splits on comma AND newline, trims, drops empty, dedups case-insensitively', () => {
    expect(parseKeywords(' счёт, накладная\nСЧЁТ ,,  спецификация ')).toEqual(['счёт', 'накладная', 'спецификация'])
  })
  it('returns [] for empty/whitespace', () => {
    expect(parseKeywords('')).toEqual([])
    expect(parseKeywords('  ,\n , ')).toEqual([])
  })
})

describe('rulesToRows', () => {
  it('joins keywords and reads type + target entityTypeId', () => {
    const rules: RoutingRule[] = [
      { match: { type: 'накладная', keywords: ['ттн', 'накл'] }, target: { entityTypeId: 2 } },
      { match: { keywords: ['счёт'] }, target: { entityTypeId: 31 } }
    ]
    expect(rulesToRows(rules)).toEqual([
      { type: 'накладная', keywords: 'ттн, накл', entityTypeId: 2 },
      { type: '', keywords: 'счёт', entityTypeId: 31 }
    ])
  })
  it('nulls a non-positive/absent target and tolerates missing match fields', () => {
    const rules = [{ match: {}, target: { entityTypeId: 0 } }] as unknown as RoutingRule[]
    expect(rulesToRows(rules)).toEqual([{ type: '', keywords: '', entityTypeId: null }])
  })
  it('returns [] for null/non-array', () => {
    expect(rulesToRows(null)).toEqual([])
    expect(rulesToRows(undefined)).toEqual([])
  })
})

describe('rowsToRules', () => {
  it('builds rules, keeping only present conditions', () => {
    expect(rowsToRules([
      { type: 'накладная', keywords: 'ттн, накл', entityTypeId: 2 },
      { type: '', keywords: 'счёт', entityTypeId: 31 }
    ])).toEqual([
      { match: { type: 'накладная', keywords: ['ттн', 'накл'] }, target: { entityTypeId: 2 } },
      { match: { keywords: ['счёт'] }, target: { entityTypeId: 31 } }
    ])
  })
  it('drops a conditionless row (no type AND no keywords → never matches)', () => {
    expect(rowsToRules([{ type: '  ', keywords: ' , \n ', entityTypeId: 2 }])).toEqual([])
  })
  it('drops a row with an invalid target (null/zero/negative/non-integer entityTypeId)', () => {
    expect(rowsToRules([
      { type: 'накладная', keywords: '', entityTypeId: null },
      { type: 'счёт', keywords: '', entityTypeId: 0 },
      { type: 'КП', keywords: '', entityTypeId: -1 },
      { type: 'прайс', keywords: '', entityTypeId: 2.5 },
      { type: 'спецификация', keywords: '', entityTypeId: 1032 }
    ])).toEqual([
      { match: { type: 'спецификация' }, target: { entityTypeId: 1032 } }
    ])
  })
  it('round-trips with rulesToRows (editor output survives the parse convention)', () => {
    const rules: RoutingRule[] = [
      { match: { type: 'накладная', keywords: ['ттн'] }, target: { entityTypeId: 2 } },
      { match: { keywords: ['счёт'] }, target: { entityTypeId: 31 } }
    ]
    expect(rowsToRules(rulesToRows(rules))).toEqual(rules)
  })
  it('preserves a category/stage-scoped target across the round-trip (not stripped)', () => {
    const rules: RoutingRule[] = [
      { match: { type: 'накладная' }, target: { entityTypeId: 1032, categoryId: 7, stageId: 'DT1032_7:NEW' } }
    ]
    expect(rowsToRules(rulesToRows(rules))).toEqual(rules)
  })
  it('caps the rules list and per-rule keywords (mirrors parsePortalSettings DoS caps)', () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ type: 'накладная', keywords: `k${i}`, entityTypeId: 2 }))
    expect(rowsToRules(many).length).toBe(200) // MAX_ROUTING_RULES
    const kw = Array.from({ length: 150 }, (_, i) => `k${i}`).join(',')
    expect(parseKeywords(kw).length).toBe(100) // MAX_RULE_KEYWORDS
  })
})
