import { describe, expect, it, vi } from 'vitest'
import { dispatchLegalNotices } from '../server/utils/legalNoticeDispatch'
import type { PendingLegalEdition } from '../app/utils/legalNotice'

const EDITION: PendingLegalEdition = {
  slug: 'eula',
  title: 'Лицензионное соглашение',
  date: '2026-09-01',
  publishedAt: '2026-09-01',
  material: true,
  changes: ['Добавлен раздел о переносе на сервер клиента.'],
  previousDate: '2026-08-08'
}

function deps(over: Partial<Parameters<typeof dispatchLegalNotices>[0]> = {}) {
  return {
    today: '2026-09-02',
    editions: [EDITION],
    pendingPortals: vi.fn(async (_k: string, _l: number, after: string) => (after ? [] : ['m1', 'm2'])),
    send: vi.fn(async () => 'sent' as const),
    markSent: vi.fn(async () => {}),
    docUrl: (p: string) => `https://example.com${p}`,
    ...over
  }
}

describe('#418: рассылка уведомления в чаты порталов', () => {
  it('уходит каждому порталу и отмечается', async () => {
    const d = deps()
    const r = await dispatchLegalNotices(d)
    expect(r).toMatchObject({ sent: 2, failed: 0, undeliverable: 0 })
    expect(d.markSent).toHaveBeenCalledTimes(2)
    expect(String(d.send.mock.calls[0]![1])).toContain('01.10.2026')
  })

  it('отметка ставится ТОЛЬКО по факту доставки', async () => {
    // ⚠ Обратный порядок хоронил бы уведомление навсегда при первом же сбое портала: следующий
    // проход счёл бы его отправленным, лицензиат не узнал бы об изменении, а в журнале стояла бы
    // отметка о доставке. Тот же урок, что с телеграм-тревогами.
    const d = deps({ send: vi.fn(async () => 'failed' as const) })
    const r = await dispatchLegalNotices(d)
    expect(r).toMatchObject({ sent: 0, failed: 2 })
    expect(d.markSent).not.toHaveBeenCalled()
  })

  it('падение одного портала не останавливает рассылку остальным', async () => {
    // Недоступный портал (мёртвый токен, удалённый чат) — обычное состояние в мультитенанте, и
    // один такой не вправе задержать уведомление всем прочим.
    const send = vi.fn(async (m: string) => {
      if (m === 'm1') throw new Error('portal down')
      return 'sent' as const
    })
    const d = deps({ send })
    const r = await dispatchLegalNotices(d)
    expect(r).toMatchObject({ sent: 1, failed: 1 })
    expect(d.markSent).toHaveBeenCalledExactlyOnceWith('m2', 'eula@2026-09-01')
  })

  it('после даты вступления не рассылаем', async () => {
    // Писать поздно: уведомлением это уже не будет, а выглядело бы как запоздалое оправдание.
    const d = deps({ today: '2026-10-01' })
    const r = await dispatchLegalNotices(d)
    expect(r.sent).toBe(0)
    expect(d.pendingPortals).not.toHaveBeenCalled()
  })

  it('до даты публикации тоже молчим', async () => {
    const d = deps({ today: '2026-08-31' })
    expect((await dispatchLegalNotices(d)).sent).toBe(0)
    expect(d.pendingPortals).not.toHaveBeenCalled()
  })

  it('объявлений нет — ни одного обращения к базе', async () => {
    // Рабочее состояние до первого изменения документов: механизм есть, работы нет.
    const d = deps({ editions: [] })
    expect(await dispatchLegalNotices(d)).toMatchObject({ sent: 0, failed: 0 })
    expect(d.pendingPortals).not.toHaveBeenCalled()
    expect(d.send).not.toHaveBeenCalled()
  })

  it('повторный проход ничего не дублирует', async () => {
    // Защита от повтора — та же отметка: портал, которому написали, из выборки уходит.
    const done = new Set<string>()
    const d = deps({
      pendingPortals: vi.fn(async (_k: string, _l: number, after: string) => (after ? [] : ['m1', 'm2'].filter(m => !done.has(m)))),
      markSent: vi.fn(async (m: string) => { done.add(m) })
    })
    await dispatchLegalNotices(d)
    const second = await dispatchLegalNotices(d)
    expect(second).toMatchObject({ sent: 0, failed: 0 })
  })

  it('«доставлять некуда» отличается от «не доставилось»', async () => {
    // ⚠ Слитые в одно, они делали очередь неотличимой от рабочей ровно тогда, когда она стояла:
    // портал без настроенного чата недоставляем ПОСТОЯННО, а не временно.
    const d = deps({ send: vi.fn(async () => 'no-channel' as const) })
    const r = await dispatchLegalNotices(d)
    expect(r).toMatchObject({ sent: 0, failed: 0, undeliverable: 2 })
    expect(d.markSent).not.toHaveBeenCalled()
  })

  it('очередь не встаёт на недоставляемых порталах — обход идёт курсором', async () => {
    // ⚠ Прежняя выборка брала первые N и возвращала их ВЕЧНО: пятьдесят порталов без чата в начале
    // алфавита блокировали бы всех остальных навсегда, а рассылка выглядела бы работающей.
    const all = Array.from({ length: 120 }, (_, i) => `m${String(i).padStart(3, '0')}`)
    const sentTo: string[] = []
    const d = deps({
      pendingPortals: vi.fn(async (_k: string, limit: number, after: string) => all.filter(m => m > after).slice(0, limit)),
      send: vi.fn(async (m: string) => (m < 'm050' ? 'no-channel' as const : 'sent' as const)),
      markSent: vi.fn(async (m: string) => { sentTo.push(m) })
    })
    const r = await dispatchLegalNotices(d)
    expect(r.undeliverable).toBe(50)
    expect(r.sent).toBe(70)
    expect(sentTo).toContain('m119')
  })

  it('битое объявление не рассылается вовсе и названо', async () => {
    // Кривая дата даёт ссылку на несуществующую редакцию и дату вступления, не равную обещанной —
    // и уходит сразу в чужие чаты, откуда не отзывается. Лучше не отправить и закричать.
    const d = deps({ problems: () => ['дата публикации не существует'] })
    const r = await dispatchLegalNotices(d)
    expect(r.sent).toBe(0)
    expect(r.rejected[0]).toContain('дата публикации не существует')
    expect(d.pendingPortals).not.toHaveBeenCalled()
  })
})
