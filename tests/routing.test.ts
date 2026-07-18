import { describe, expect, it, vi } from 'vitest'
import type { RoutingRule, TargetRef } from '../app/types/mapping'
import { FALLBACK_TARGET, resolveTarget, resolveValidTarget, ruleMatches } from '../app/utils/routing'

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

describe('resolveValidTarget — deleted-funnel fallback (user clarification)', () => {
  const DEAL_CAT1 = { entityTypeId: 2, categoryId: 1 }
  const DEAL_CAT3 = { entityTypeId: 2, categoryId: 3 }
  // deal funnels currently on the portal: 0 and 3 (funnel 1 was DELETED).
  const listIds = async (etid: number) => (etid === 2 ? [0, 3] : etid === 31 ? [11] : [])

  it('keeps the resolved target when its direction still exists', async () => {
    expect(await resolveValidTarget(DEAL_CAT3, DEAL_CAT3, listIds)).toEqual(DEAL_CAT3)
  })
  it('keeps a target with NO categoryId as-is (no REST check)', async () => {
    const called = { n: 0 }
    const spy = async (e: number) => {
      called.n++
      return listIds(e)
    }
    expect(await resolveValidTarget({ entityTypeId: 2 }, DEAL_CAT3, spy)).toEqual({ entityTypeId: 2 })
    expect(called.n).toBe(0)
  })
  it('rule/manual with a DELETED direction → falls to the default target', async () => {
    // resolved pins deal funnel 1 (deleted); default is deal funnel 3 (valid) → use default.
    expect(await resolveValidTarget(DEAL_CAT1, DEAL_CAT3, listIds)).toEqual(DEAL_CAT3)
  })
  it('default with a DELETED direction → hard anchor deal / direction 0', async () => {
    // both resolved and default pin the deleted funnel 1 → FALLBACK_TARGET (deal, category 0).
    expect(await resolveValidTarget(DEAL_CAT1, DEAL_CAT1, listIds)).toEqual(FALLBACK_TARGET)
    expect(FALLBACK_TARGET).toEqual({ entityTypeId: 2, categoryId: 0 })
  })
  it('fail-open: listCategoryIds throws → use the resolved target as-is (never block the import)', async () => {
    const boom = async () => {
      throw new Error('read failed')
    }
    expect(await resolveValidTarget(DEAL_CAT1, DEAL_CAT3, boom)).toEqual(DEAL_CAT1)
  })
  it('fail-open: empty funnel list (can\'t verify) → use as-is', async () => {
    expect(await resolveValidTarget({ entityTypeId: 999, categoryId: 5 }, DEAL_CAT3, async () => [])).toEqual({ entityTypeId: 999, categoryId: 5 })
  })
  it('the hard anchor (deal/0) is NOT validated by REST — the common default path is free', async () => {
    const spy = vi.fn(async () => [0, 3])
    // resolved === default === FALLBACK_TARGET (deal, dir 0) → short-circuit, no crm.category.list.
    expect(await resolveValidTarget(FALLBACK_TARGET, FALLBACK_TARGET, spy)).toEqual(FALLBACK_TARGET)
    expect(spy).not.toHaveBeenCalled()
  })
  it('memoizes crm.category.list per entityTypeId across the chain (one call, not two)', async () => {
    const spy = vi.fn(async () => [0, 3]) // funnels 5 and 7 both gone
    const out = await resolveValidTarget({ entityTypeId: 2, categoryId: 5 }, { entityTypeId: 2, categoryId: 7 }, spy)
    expect(out).toEqual(FALLBACK_TARGET) // both gone → anchor
    expect(spy).toHaveBeenCalledTimes(1) // deal categories fetched once, reused for the 2nd deal target
  })
})
