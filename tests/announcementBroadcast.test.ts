import { describe, expect, it, vi } from 'vitest'
import { MAX_BROADCAST_PORTALS, broadcastAnnouncement } from '../server/utils/announcementBroadcast'
import { ANNOUNCEMENT_PULL_COMMAND, buildAnnouncementEvent } from '~/utils/announcementPull'

// #478. Объявление доезжало ТОЛЬКО когда сотрудник открывал рабочий экран, а вкладку в портале не
// перезагружают сутками — у того, кто держит её открытой, объявление не появлялось вовсе.

const deps = (over: Partial<Parameters<typeof broadcastAnnouncement>[0]> = {}) => ({
  listPortals: async () => ['m1', 'm2'],
  callFor: async () => vi.fn(async () => ({})) as never,
  moduleId: 'shef.priceimport',
  ...over
})

describe('#478: форма события', () => {
  it('своя команда, а не `reload.options`', () => {
    // ⚠ Одна команда на объявление и настройки означала бы лишний запрос настроек на каждое
    // объявление и лишний запрос объявления на каждое сохранение — удвоение обращений к нашему
    // серверу ради экономии одной строки.
    const e = buildAnnouncementEvent('code')
    expect(e.COMMAND).toBe(ANNOUNCEMENT_PULL_COMMAND)
    expect(e.COMMAND).not.toBe('reload.options')
    expect(e.MODULE_ID).toBe('code')
  })

  it('в событии НЕТ самого объявления — только сигнал «сходи проверь»', () => {
    // ⚠ Несущее свойство: содержимому события доверять нельзя, а картинка в base64 раздула бы
    // канал. Текст, картинку и срок клиент берёт своим проверенным запросом.
    expect(buildAnnouncementEvent('code').PARAMS).toEqual({})
  })
})

describe('#478: рассылка по порталам', () => {
  it('шлёт каждому порталу и считает доставленные', async () => {
    const calls: Array<[string, unknown]> = []
    const s = await broadcastAnnouncement(deps({
      callFor: async () => (async (m: string, p: unknown) => {
        calls.push([m, p])
        return {}
      }) as never
    }))
    expect(s).toMatchObject({ total: 2, sent: 2, failed: 0, truncated: false })
    expect(calls).toHaveLength(2)
    expect(calls[0]?.[0]).toBe('pull.application.event.add')
  })

  it('портал без токена считается отдельным классом, а не общей ошибкой', async () => {
    // По нему видно, что это не наша поломка, а разъехавшийся клиент: приложение удалили, а событие
    // деинсталляции ещё не доехало.
    const s = await broadcastAnnouncement(deps({ callFor: async () => null }))
    expect(s).toMatchObject({ sent: 0, failed: 2, byReason: { 'no-token': 2 } })
  })

  it('отказ ОДНОГО портала не прерывает обход остальных', async () => {
    // ⚠ Иначе один криво настроенный клиент лишал бы сигнала всех, кто стоит за ним в списке.
    const s = await broadcastAnnouncement(deps({
      listPortals: async () => ['bad', 'good'],
      callFor: async m => (m === 'bad'
        ? async () => {
          throw new Error('ACCESS_DENIED')
        }
        : async () => ({})) as never
    }))
    expect(s).toMatchObject({ total: 2, sent: 1, failed: 1, byReason: { refused: 1 } })
  })

  it('выборка обрезается по капу И об этом СКАЗАНО', async () => {
    // ⚠ «Разослали всем» и «разослали первой тысяче» выглядят в отчёте одинаково, если про кап
    // промолчать. Тот же приём, что у обрезки в сводке отзывов.
    const many = Array.from({ length: MAX_BROADCAST_PORTALS + 3 }, (_, i) => `m${i}`)
    const s = await broadcastAnnouncement(deps({ listPortals: async () => many }))
    expect(s.total).toBe(MAX_BROADCAST_PORTALS)
    expect(s.truncated).toBe(true)
  })

  it('в журнал идёт СВОДКА, без идентификаторов порталов и текста ошибок', async () => {
    // ⚠ Текст ошибки портала вправе процитировать параметры вызова, а member_id — идентификатор
    // клиента. Классов достаточно, чтобы понять причину.
    const lines: string[] = []
    await broadcastAnnouncement(deps({
      listPortals: async () => ['member-secret'],
      callFor: async () => (async () => {
        throw new Error('ACCESS_DENIED: подробности вызова')
      }) as never,
      log: m => lines.push(m)
    }))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('не удалось 1')
    expect(lines[0]).not.toContain('member-secret')
    expect(lines[0]).not.toContain('подробности вызова')
  })

  it('порталов нет — рассылка проходит вхолостую, а не падает', async () => {
    const s = await broadcastAnnouncement(deps({ listPortals: async () => [] }))
    expect(s).toMatchObject({ total: 0, sent: 0, failed: 0, truncated: false })
  })
})
