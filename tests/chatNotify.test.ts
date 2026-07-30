import { describe, expect, it, vi } from 'vitest'
import {
  buildErrorMessage,
  buildSuccessMessage,
  entityChatLink,
  entityLink,
  neutralizeBb,
  sendChatMessage
} from '../server/utils/chatNotify'

describe('neutralizeBb', () => {
  it('folds BB brackets to fullwidth (blocks [url]/mentions injection)', () => {
    expect(neutralizeBb('[url=x]click[/url]')).toBe('［url=x］click［/url］')
    expect(neutralizeBb('plain')).toBe('plain')
  })
  it('tolerates null/undefined', () => {
    expect(neutralizeBb(undefined as unknown as string)).toBe('')
  })
})

describe('entityLink', () => {
  it('maps deal/quote to detail paths, others to universal type path', () => {
    expect(entityLink(1, 4)).toBe('/crm/lead/details/4/') // #135
    expect(entityLink(2, 5)).toBe('/crm/deal/details/5/')
    expect(entityLink(7, 9)).toBe('/crm/quote/show/9/')
    expect(entityLink(1032, 3)).toBe('/crm/type/1032/details/3/')
  })
})

describe('entityChatLink', () => {
  it('builds an ABSOLUTE clickable BB-link when the portal host is known', () => {
    expect(entityChatLink(2, 31, 'bel.bitrix24.by')).toBe('[URL=https://bel.bitrix24.by/crm/deal/details/31/]Открыть в CRM[/URL]')
  })
  it('normalises a scheme/path off the passed domain', () => {
    expect(entityChatLink(2, 31, 'https://bel.bitrix24.by/')).toBe('[URL=https://bel.bitrix24.by/crm/deal/details/31/]Открыть в CRM[/URL]')
  })
  it('falls back to a portal-relative BB-link when no host is known', () => {
    expect(entityChatLink(2, 31)).toBe('[URL=/crm/deal/details/31/]Открыть в CRM[/URL]')
  })
})

describe('buildSuccessMessage', () => {
  it('neutralises supplier + warnings and appends the entity link', () => {
    const msg = buildSuccessMessage({
      supplierName: 'ООО [url=evil]Ромашка[/url]',
      entityTypeId: 2,
      entityId: 5,
      created: true,
      rowCount: 3,
      warnings: ['Поставщик не найден']
    })
    expect(msg).toContain('✅ Импортирован документ')
    expect(msg).not.toContain('[url=evil]')
    expect(msg).toContain('Позиций: 3')
    // The entity link is now a clickable BB-link, not a bare path (owner ask).
    expect(msg).toContain('[URL=/crm/deal/details/5/]Открыть в CRM[/URL]')
  })
  it('emits an absolute clickable link when a portal domain is supplied', () => {
    const msg = buildSuccessMessage({ entityTypeId: 2, entityId: 5, created: true, rowCount: 1, warnings: [] }, 'bel.bitrix24.by')
    expect(msg).toContain('[URL=https://bel.bitrix24.by/crm/deal/details/5/]Открыть в CRM[/URL]')
  })
  it('marks an already-imported (not created) document', () => {
    const msg = buildSuccessMessage({ entityTypeId: 2, entityId: 1, created: false, rowCount: 0, warnings: [] })
    expect(msg).toContain('уже был импортирован')
  })
  it('omits the warnings block entirely when there are none', () => {
    const msg = buildSuccessMessage({ entityTypeId: 2, entityId: 1, created: true, rowCount: 1, warnings: [] })
    expect(msg).not.toContain('Предупреждения')
  })
  it('caps the warnings block at 10 lines', () => {
    const warnings = Array.from({ length: 15 }, (_, i) => `w${i}`)
    const msg = buildSuccessMessage({ entityTypeId: 2, entityId: 1, created: true, rowCount: 1, warnings })
    expect(msg).toContain('Предупреждения (15)') // header shows the true count
    expect(msg).toContain('• w9')
    expect(msg).not.toContain('• w10') // but only 10 lines rendered
  })
})

describe('buildErrorMessage', () => {
  it('lists messages BB-safely under a header', () => {
    const msg = buildErrorMessage('[b]Ромашка[/b]', ['Валюта XXX отсутствует'])
    expect(msg).toContain('⛔ Импорт не выполнен')
    expect(msg).not.toContain('[b]')
    expect(msg).toContain('• Валюта XXX отсутствует')
  })
  it('caps the message list at 20 lines', () => {
    const messages = Array.from({ length: 25 }, (_, i) => `e${i}`)
    const msg = buildErrorMessage(undefined, messages)
    expect(msg).toContain('• e19')
    expect(msg).not.toContain('• e20')
  })
})

describe('sendChatMessage', () => {
  it('calls im.message.add with URL_PREVIEW off and returns the id', async () => {
    const call = vi.fn(async () => 7307)
    const id = await sendChatMessage('chat55', 'hi', call)
    expect(id).toBe(7307)
    expect(call).toHaveBeenCalledWith('im.message.add', { DIALOG_ID: 'chat55', MESSAGE: 'hi', URL_PREVIEW: 'N' })
  })
  it('no-ops on empty dialog or message', async () => {
    const call = vi.fn(async () => 1)
    expect(await sendChatMessage('', 'hi', call)).toBeNull()
    expect(await sendChatMessage('chat1', '   ', call)).toBeNull()
    expect(call).not.toHaveBeenCalled()
  })
  it('returns null on a non-numeric result', async () => {
    const call = vi.fn(async () => ({} as unknown))
    expect(await sendChatMessage('chat1', 'hi', call)).toBeNull()
  })
})
