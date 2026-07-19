import { describe, expect, it } from 'vitest'
import { entityTypeLabel, resolveFeedbackEntity } from '../server/utils/feedbackEntity'
import type { JobResultView } from '../app/utils/jobStatus'

const view = (o: Partial<JobResultView>): JobResultView => ({ warnings: [], errors: [], ...o })

describe('entityTypeLabel', () => {
  it('labels the known CRM types', () => {
    expect(entityTypeLabel(1)).toBe('Лид')
    expect(entityTypeLabel(2)).toBe('Сделка')
    expect(entityTypeLabel(7)).toBe('Предложение')
    expect(entityTypeLabel(31)).toBe('Счёт')
  })
  it('falls back for smart-processes / unknown types', () => {
    expect(entityTypeLabel(1030)).toBe('Смарт-процесс (тип 1030)')
  })
})

describe('resolveFeedbackEntity', () => {
  it('builds an absolute on-portal link for a created deal', () => {
    expect(resolveFeedbackEntity(view({ created: true, entityTypeId: 2, entityId: 42 }), 'acme.bitrix24.by'))
      .toEqual({ entityType: 'Сделка', entityId: '42', entityUrl: 'https://acme.bitrix24.by/crm/deal/details/42/' })
  })
  it('uses the universal detail path for a smart-process', () => {
    const r = resolveFeedbackEntity(view({ created: true, entityTypeId: 1030, entityId: 7 }), 'acme.bitrix24.by')
    expect(r.entityUrl).toBe('https://acme.bitrix24.by/crm/type/1030/details/7/')
    expect(r.entityType).toBe('Смарт-процесс (тип 1030)')
  })
  it('falls back to a relative path when domain is empty/non-string', () => {
    expect(resolveFeedbackEntity(view({ created: true, entityTypeId: 2, entityId: 42 }), '').entityUrl).toBe('/crm/deal/details/42/')
    expect(resolveFeedbackEntity(view({ created: true, entityTypeId: 2, entityId: 42 }), null).entityUrl).toBe('/crm/deal/details/42/')
  })
  it('returns {} when nothing was created', () => {
    expect(resolveFeedbackEntity(view({ created: false, entityTypeId: 2, entityId: 42 }), 'x.bitrix24.by')).toEqual({})
    expect(resolveFeedbackEntity(view({ entityTypeId: 2, entityId: 42 }), 'x.bitrix24.by')).toEqual({})
  })
  it('returns {} when type or id is missing/invalid (pre-#192 rows, abandoned jobs)', () => {
    expect(resolveFeedbackEntity(view({ created: true, entityId: 42 }), 'x.bitrix24.by')).toEqual({})
    expect(resolveFeedbackEntity(view({ created: true, entityTypeId: 2 }), 'x.bitrix24.by')).toEqual({})
    expect(resolveFeedbackEntity(view({ created: true, entityTypeId: 2, entityId: 0 }), 'x.bitrix24.by')).toEqual({})
  })
})
