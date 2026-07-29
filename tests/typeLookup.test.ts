import { describe, expect, it, vi } from 'vitest'
import { fetchSmartProcessTypes, probeSmartInvoiceEnabled } from '../server/utils/typeLookup'

describe('fetchSmartProcessTypes', () => {
  it('maps dynamic SPA (≥1000) that CAN hold products → {…,hasCategories,hasStages}, sorted; drops the rest', async () => {
    const call = vi.fn(async () => ({
      types: [
        { entityTypeId: 1050, title: 'Заявки', isCategoriesEnabled: 'Y', isStagesEnabled: 'N', isLinkWithProductsEnabled: 'Y' },
        { entityTypeId: 1044, title: 'Договоры', isCategoriesEnabled: 'N', isStagesEnabled: 'Y', isLinkWithProductsEnabled: 'N' }, // NO products → excluded
        { entityTypeId: 1060, title: 'Заказы', isCategoriesEnabled: 'N', isStagesEnabled: 'Y', isLinkWithProductsEnabled: 'Y' },
        { entityTypeId: 31, title: 'Смарт-счёт', isLinkWithProductsEnabled: 'Y' } // NOT ≥1000 → excluded
      ]
    }))
    expect(await fetchSmartProcessTypes(call as never)).toEqual([
      { entityTypeId: 1060, title: 'Заказы', hasCategories: false, hasStages: true },
      { entityTypeId: 1050, title: 'Заявки', hasCategories: true, hasStages: false }
    ])
  })
  it('drops titleless / non-integer entityTypeId / products-off rows', async () => {
    const call = vi.fn(async () => ({ types: [
      { entityTypeId: 1044, title: '', isCategoriesEnabled: 'Y', isLinkWithProductsEnabled: 'Y' },
      { entityTypeId: 'x', title: 'Bad', isStagesEnabled: 'Y', isLinkWithProductsEnabled: 'Y' },
      { entityTypeId: 1070, title: 'НетТоваров', isLinkWithProductsEnabled: 'N' }
    ] }))
    expect(await fetchSmartProcessTypes(call as never)).toEqual([])
  })
  it('→ [] on a failed call or a non-array result (never throws)', async () => {
    expect(await fetchSmartProcessTypes(vi.fn(() => Promise.reject(new Error('boom'))) as never)).toEqual([])
    expect(await fetchSmartProcessTypes(vi.fn(async () => ({})) as never)).toEqual([])
  })
})

describe('probeSmartInvoiceEnabled (#269)', () => {
  it('портал отдал поля → смарт-счета доступны', async () => {
    expect(await probeSmartInvoiceEnabled(async () => ({ fields: { id: {} } }))).toBe(true)
  })

  it('портал ответил «не поддерживается» → доступа нет (это и есть определённое НЕТ)', async () => {
    const call = async () => {
      throw new Error('Сущность CRM не поддерживается')
    }
    expect(await probeSmartInvoiceEnabled(call)).toBe(false)
  })

  it('голый NOT_FOUND НЕ прячет вариант: Битрикс24 отдаёт его по многим причинам', async () => {
    const notFound = async () => {
      throw new Error('NOT_FOUND')
    }
    // Спрятать рабочую цель хуже, чем показать лишнюю: неопределённость → оставляем как есть.
    expect(await probeSmartInvoiceEnabled(notFound)).toBeNull()
  })

  it('сетевой сбой → null, вариант остаётся в списке (прятать рабочую цель хуже)', async () => {
    const call = async () => {
      throw new Error('socket hang up')
    }
    expect(await probeSmartInvoiceEnabled(call)).toBeNull()
  })

  it('запрашивает именно тип 31', async () => {
    let seen: unknown
    await probeSmartInvoiceEnabled(async (_m, p) => {
      seen = p
      return { fields: {} }
    })
    expect(seen).toEqual({ entityTypeId: 31 })
  })
})
