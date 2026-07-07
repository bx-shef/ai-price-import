import { describe, expect, it } from 'vitest'
import type { RoutingRule, TargetRef } from '../app/types/mapping'
import { resolveTarget, ruleMatches } from '../app/utils/routing'

const DEAL: TargetRef = { entityTypeId: 2, categoryId: 0 }
const INVOICE: TargetRef = { entityTypeId: 31 }
const SUPPLY: TargetRef = { entityTypeId: 2, categoryId: 7 }

describe('ruleMatches', () => {
  it('empty condition never matches (no accidental catch-all)', () => {
    expect(ruleMatches({ match: {}, target: DEAL }, { documentType: 'счёт' })).toBe(false)
  })

  it('matches by document type (homoglyph/locale-insensitive)', () => {
    const rule: RoutingRule = { match: { type: 'Счёт' }, target: INVOICE }
    expect(ruleMatches(rule, { documentType: 'счёт' })).toBe(true)
    expect(ruleMatches(rule, { documentType: 'накладная' })).toBe(false)
  })

  it('matches by keyword in text', () => {
    const rule: RoutingRule = { match: { keywords: ['ТН'] }, target: SUPPLY }
    expect(ruleMatches(rule, { text: 'Товарная накладная ТН №5' })).toBe(true)
    expect(ruleMatches(rule, { text: 'Счёт №5' })).toBe(false)
  })

  it('type + keywords are AND (both must match)', () => {
    const rule: RoutingRule = { match: { type: 'счёт', keywords: ['срочно'] }, target: INVOICE }
    expect(ruleMatches(rule, { documentType: 'счёт', text: 'обычный счёт' })).toBe(false)
    expect(ruleMatches(rule, { documentType: 'счёт', text: 'срочно оплатить' })).toBe(true)
  })

  it('empty-string keyword never matches', () => {
    expect(ruleMatches({ match: { keywords: [''] }, target: DEAL }, { text: 'что угодно' })).toBe(false)
  })
})

describe('resolveTarget', () => {
  const rules: RoutingRule[] = [
    { match: { type: 'счёт' }, target: INVOICE },
    { match: { keywords: ['ТН'] }, target: SUPPLY }
  ]

  it('manual override always wins', () => {
    const override: TargetRef = { entityTypeId: 7 }
    expect(resolveTarget({ manualOverride: override, documentType: 'счёт' }, rules, DEAL)).toBe(override)
  })

  it('first matching rule wins', () => {
    expect(resolveTarget({ documentType: 'счёт' }, rules, DEAL)).toEqual(INVOICE)
    expect(resolveTarget({ text: 'вот ТН' }, rules, DEAL)).toEqual(SUPPLY)
  })

  it('falls back to default when nothing matches', () => {
    expect(resolveTarget({ documentType: 'прайс' }, rules, DEAL)).toEqual(DEAL)
  })

  it('first matching rule wins when several match', () => {
    const overlapping: RoutingRule[] = [
      { match: { keywords: ['счёт'] }, target: INVOICE },
      { match: { keywords: ['счёт'] }, target: SUPPLY }
    ]
    expect(resolveTarget({ text: 'это счёт' }, overlapping, DEAL)).toEqual(INVOICE)
  })
})
