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

describe('rulesToRows (keyword-only editor)', () => {
  it('joins keywords + reads the target; a stored match.type is ignored (no longer edited)', () => {
    const rules: RoutingRule[] = [
      { match: { type: 'накладная', keywords: ['ттн', 'накл'] }, target: { entityTypeId: 2 } },
      { match: { keywords: ['счёт'] }, target: { entityTypeId: 31 } }
    ]
    expect(rulesToRows(rules)).toEqual([
      { keywords: 'ттн, накл', entityTypeId: 2 },
      { keywords: 'счёт', entityTypeId: 31 }
    ])
  })
  it('nulls a non-positive/absent target and tolerates missing match fields', () => {
    const rules = [{ match: {}, target: { entityTypeId: 0 } }] as unknown as RoutingRule[]
    expect(rulesToRows(rules)).toEqual([{ keywords: '', entityTypeId: null }])
  })
  it('returns [] for null/non-array', () => {
    expect(rulesToRows(null)).toEqual([])
    expect(rulesToRows(undefined)).toEqual([])
  })
})

describe('rowsToRules (keyword-only editor)', () => {
  it('builds rules from keywords + target (no type emitted)', () => {
    expect(rowsToRules([
      { keywords: 'ттн, накл', entityTypeId: 2 },
      { keywords: 'счёт', entityTypeId: 31 }
    ])).toEqual([
      { match: { keywords: ['ттн', 'накл'] }, target: { entityTypeId: 2 } },
      { match: { keywords: ['счёт'] }, target: { entityTypeId: 31 } }
    ])
  })
  it('drops a keywordless row (never matches now that type is gone)', () => {
    expect(rowsToRules([{ keywords: ' , \n ', entityTypeId: 2 }])).toEqual([])
  })
  it('drops a row with an invalid target (null/zero/negative/non-integer entityTypeId)', () => {
    expect(rowsToRules([
      { keywords: 'ттн', entityTypeId: null },
      { keywords: 'счёт', entityTypeId: 0 },
      { keywords: 'кп', entityTypeId: -1 },
      { keywords: 'прайс', entityTypeId: 2.5 },
      { keywords: 'спец', entityTypeId: 1032 }
    ])).toEqual([
      { match: { keywords: ['спец'] }, target: { entityTypeId: 1032 } }
    ])
  })
  it('round-trips with rulesToRows (editor output survives the parse convention)', () => {
    const rules: RoutingRule[] = [
      { match: { keywords: ['ттн'] }, target: { entityTypeId: 2 } },
      { match: { keywords: ['счёт'] }, target: { entityTypeId: 31 } }
    ]
    expect(rowsToRules(rulesToRows(rules))).toEqual(rules)
  })
  it('preserves a category/stage-scoped target across the round-trip (not stripped)', () => {
    const rules: RoutingRule[] = [
      { match: { keywords: ['договор'] }, target: { entityTypeId: 1032, categoryId: 7, stageId: 'DT1032_7:NEW' } }
    ]
    expect(rowsToRules(rulesToRows(rules))).toEqual(rules)
  })
  it('caps the rules list and per-rule keywords (mirrors parsePortalSettings DoS caps)', () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ keywords: `k${i}`, entityTypeId: 2 }))
    expect(rowsToRules(many).length).toBe(200) // MAX_ROUTING_RULES
    const kw = Array.from({ length: 150 }, (_, i) => `k${i}`).join(',')
    expect(parseKeywords(kw).length).toBe(100) // MAX_RULE_KEYWORDS
  })
})
