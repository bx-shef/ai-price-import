import { describe, expect, it } from 'vitest'
import { entityDetailPath, portalCurrencySettingsUrl } from '../app/utils/entityLink'

describe('entityDetailPath', () => {
  it('deal (2) → named deal route', () => {
    expect(entityDetailPath(2, 42)).toBe('/crm/deal/details/42/')
  })
  it('lead (1) → named lead route', () => {
    expect(entityDetailPath(1, 7)).toBe('/crm/lead/details/7/')
  })
  it('quote (7) → legacy quote route (NOT the universal type route)', () => {
    expect(entityDetailPath(7, 12)).toBe('/crm/quote/show/12/')
  })
  it('smart-invoice (31) + smart process (>=1000) → universal type route', () => {
    expect(entityDetailPath(31, 5)).toBe('/crm/type/31/details/5/')
    expect(entityDetailPath(1032, 9)).toBe('/crm/type/1032/details/9/')
  })
  it('invalid ids → null (no broken link)', () => {
    expect(entityDetailPath(0, 5)).toBeNull()
    expect(entityDetailPath(2, 0)).toBeNull()
    expect(entityDetailPath(undefined, 5)).toBeNull()
    expect(entityDetailPath(2, undefined)).toBeNull()
    expect(entityDetailPath(2, -1)).toBeNull()
    expect(entityDetailPath(2.5, 5)).toBeNull()
  })
})

describe('portalCurrencySettingsUrl', () => {
  it('строит ссылку на настройки валют портала', () => {
    expect(portalCurrencySettingsUrl('portal-a.bitrix24.by')).toBe('https://portal-a.bitrix24.by/crm/configs/currency/')
    expect(portalCurrencySettingsUrl('portal-b.bitrix24.kz')).toBe('https://portal-b.bitrix24.kz/crm/configs/currency/')
  })
  it('нормализует регистр и пробелы', () => {
    expect(portalCurrencySettingsUrl('  Portal.Bitrix24.RU ')).toBe('https://portal.bitrix24.ru/crm/configs/currency/')
  })
  // Чужой хост — главный случай: подпись ссылки фиксированная, подменённый домен читателю не виден.
  it('отвергает не-Bitrix24 хосты и всё, что не голый хост', () => {
    for (const bad of ['', 'localhost', 'evil.com', 'attacker.co.uk', 'bitrix24.by.evil.com', 'xn--bitrix24-hostile.com', 'https://x.bitrix24.by', 'x.bitrix24.by/evil', 'x.bitrix24.by:8080', 'u@evil.com', 'x.bitrix24.by?a=1', undefined, null]) {
      expect(portalCurrencySettingsUrl(bad as string)).toBeNull()
    }
  })
})
