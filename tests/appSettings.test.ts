import { describe, expect, it, vi } from 'vitest'
import { readMapping, SETTINGS_KEY, writeMapping } from '../server/utils/appSettings'

describe('readMapping', () => {
  it('parses stored JSON string and normalises', async () => {
    const call = vi.fn().mockResolvedValue(JSON.stringify({ defaultTarget: { entityTypeId: 31 }, saveFile: false }))
    const m = await readMapping(call)
    expect(call).toHaveBeenCalledWith('app.option.get', { option: SETTINGS_KEY })
    expect(m.defaultTarget).toEqual({ entityTypeId: 31 })
  })
  it('handles object result and junk → safe defaults', async () => {
    // ⚠ Старое `saveFile` в сохранённом блобе просто игнорируется (#458), а не отвергается:
    // портал со старыми настройками обязан работать, а не оказаться «ненастроенным».
    expect((await readMapping(vi.fn().mockResolvedValue({ saveFile: false }))).configured).toBe(false)
    expect((await readMapping(vi.fn().mockResolvedValue('not json'))).defaultTarget).toEqual({ entityTypeId: 2, categoryId: 0 })
  })
  it('unset option ("" / null) → defaults (first-run path)', async () => {
    expect((await readMapping(vi.fn().mockResolvedValue(''))).defaultTarget).toEqual({ entityTypeId: 2, categoryId: 0 })
    expect((await readMapping(vi.fn().mockResolvedValue(null))).defaultTarget).toEqual({ entityTypeId: 2, categoryId: 0 })
  })
})

describe('writeMapping', () => {
  it('normalises before persisting (never stores junk)', async () => {
    const call = vi.fn().mockResolvedValue(true)
    const out = await writeMapping(call, { defaultTarget: { entityTypeId: -1 }, routingRules: [{ match: {}, target: { entityTypeId: 5 } }] })
    // bad default → 2; empty-condition rule dropped
    expect(out.defaultTarget).toEqual({ entityTypeId: 2, categoryId: 0 })
    expect(out.routingRules).toEqual([])
    const [method, params] = call.mock.calls[0]!
    expect(method).toBe('app.option.set')
    expect(JSON.parse((params as { options: Record<string, string> }).options[SETTINGS_KEY]!).defaultTarget.entityTypeId).toBe(2)
  })

  it('#373: отмечает портал настроенным — сам факт записи и есть «админ сохранил»', async () => {
    const call = vi.fn().mockResolvedValue(true)
    const out = await writeMapping(call, {})
    expect(out.configured).toBe(true)
    const params = call.mock.calls[0]![1] as { options: Record<string, string> }
    expect(JSON.parse(params.options[SETTINGS_KEY]!).configured).toBe(true)
  })

  it('#373: клиентскому полю не верим — флаг ставит только сама запись', async () => {
    // Иначе портал объявил бы себя настроенным, ничего не настроив, и гейт `/app` погас бы зря.
    // Проверяем через чтение: разобранный блоб с `configured:false` после записи всё равно true,
    // а вот прочитать чужое `true` без записи нельзя — это покрыто в portalSettings.
    const call = vi.fn().mockResolvedValue(true)
    expect((await writeMapping(call, { configured: false })).configured).toBe(true)
  })

  it('#373: прочитанные настройки без флага остаются ненастроенными', async () => {
    expect((await readMapping(vi.fn().mockResolvedValue({ saveFile: false }))).configured).toBe(false)
  })
})
