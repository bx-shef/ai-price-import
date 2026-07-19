import { describe, expect, it } from 'vitest'
import { defaultMapping, isPortalConfigured, parsePortalSettings } from '../app/utils/portalSettings'

describe('parsePortalSettings', () => {
  it('empty/invalid → safe defaults', () => {
    expect(parsePortalSettings(null)).toEqual(defaultMapping())
    expect(parsePortalSettings('nope')).toEqual(defaultMapping())
    expect(parsePortalSettings({}).defaultTarget).toEqual({ entityTypeId: 2, categoryId: 0 })
  })

  it('coerces article/product/units', () => {
    const m = parsePortalSettings({
      article: { field: 'PROP', kind: 'string', delimiter: ';' },
      product: { by: 'name', onMissing: 'freeform' },
      units: { dictionary: { ШТ: '796', bad: 'x' }, defaultCode: 166, autoCreate: true },
      saveFile: false
    })
    expect(m.article).toEqual({ field: 'PROP', kind: 'string', delimiter: ';' })
    expect(m.product).toEqual({ by: 'name', onMissing: 'freeform' })
    expect(m.units.dictionary).toEqual({ шт: 796 }) // lower-cased, invalid dropped
    expect(m.units.defaultCode).toBe(166)
    expect(m.saveFile).toBe(false)
  })

  it('drops routing rules with empty condition, keeps valid', () => {
    const m = parsePortalSettings({
      routingRules: [
        { match: {}, target: { entityTypeId: 31 } },
        { match: { type: 'счёт' }, target: { entityTypeId: 31 } },
        { match: { keywords: ['ТН', ''] }, target: { entityTypeId: 2, categoryId: 7 } }
      ]
    })
    expect(m.routingRules).toHaveLength(2)
    expect(m.routingRules[0]!.target.entityTypeId).toBe(31)
    expect(m.routingRules[1]!.match.keywords).toEqual(['ТН'])
  })

  it('bad target entityTypeId falls back to default', () => {
    const m = parsePortalSettings({ defaultTarget: { entityTypeId: -1 } })
    expect(m.defaultTarget).toEqual({ entityTypeId: 2, categoryId: 0 })
  })
  it('caps a bloated routingRules array (DoS bound #83)', () => {
    const rules = Array.from({ length: 5000 }, () => ({ match: { type: 'x' }, target: { entityTypeId: 2 } }))
    const m = parsePortalSettings({ routingRules: rules })
    expect(m.routingRules.length).toBe(200)
  })
  it('caps rule keywords and the unit dictionary (DoS bound #83)', () => {
    const m = parsePortalSettings({
      routingRules: [{ match: { keywords: Array.from({ length: 5000 }, (_, i) => `k${i}`) }, target: { entityTypeId: 2 } }],
      units: { dictionary: Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`u${i}`, i + 1])) }
    })
    expect(m.routingRules[0]!.match.keywords!.length).toBe(100)
    expect(Object.keys(m.units.dictionary).length).toBe(1000)
  })
})

describe('isPortalConfigured', () => {
  it('pristine defaults → not configured', () => {
    expect(isPortalConfigured(defaultMapping())).toBe(false)
    expect(isPortalConfigured(parsePortalSettings(null))).toBe(false)
    expect(isPortalConfigured(parsePortalSettings({}))).toBe(false)
  })
  it('any single meaningful setting flips it to configured', () => {
    const cfg = (patch: Record<string, unknown>) => isPortalConfigured(parsePortalSettings({ ...patch }))
    expect(cfg({ article: { field: 'PROPERTY_123' } })).toBe(true)
    expect(cfg({ notifyChatId: 'chat42' })).toBe(true)
    expect(cfg({ errorChatId: 'chat7' })).toBe(true)
    expect(cfg({ routingRules: [{ match: { type: 'накладная' }, target: { entityTypeId: 2 } }] })).toBe(true)
    expect(cfg({ units: { dictionary: { шт: 796 } } })).toBe(true)
    expect(cfg({ saveFile: true })).toBe(true)
    expect(cfg({ product: { by: 'name', onMissing: 'skip-warn' } })).toBe(true)
    expect(cfg({ product: { by: 'article', onMissing: 'create' } })).toBe(true)
    expect(cfg({ units: { defaultCode: 166 } })).toBe(true)
    expect(cfg({ units: { autoCreate: true } })).toBe(true)
    expect(cfg({ defaultTarget: { entityTypeId: 31 } })).toBe(true) // moved off the deal anchor
    expect(cfg({ defaultTarget: { entityTypeId: 2, categoryId: 3 } })).toBe(true) // non-default funnel
    expect(cfg({ defaultTarget: { entityTypeId: 2, categoryId: 0, stageId: 'NEW' } })).toBe(true)
  })
  it('an empty article field / whitespace stays not-configured', () => {
    expect(isPortalConfigured(parsePortalSettings({ article: { field: '   ' } }))).toBe(false)
  })
})
