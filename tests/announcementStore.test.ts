import { describe, expect, it, vi } from 'vitest'
import { ANNOUNCEMENT_KEY, clearAnnouncement, readAnnouncement, writeAnnouncement } from '../server/utils/announcementStore'
import { memoryAnnouncementRedis } from '../server/utils/announcementRedis'
import { buildAnnouncement } from '../app/utils/announcement'

const NOW = Date.parse('2026-08-08T12:00:00Z')
const make = (days = 7) => buildAnnouncement({ title: 'Акция', text: 'Скидка', days }, NOW)

describe('хранилище объявления', () => {
  it('записанное читается обратно', async () => {
    const r = memoryAnnouncementRedis()
    const a = make()
    expect(await writeAnnouncement(r, a, NOW)).toBe(true)
    expect((await readAnnouncement(r, NOW))?.id).toBe(a.id)
  })

  it('новое объявление ЗАМЕЩАЕТ прежнее — очереди нет', async () => {
    const r = memoryAnnouncementRedis()
    await writeAnnouncement(r, make(), NOW)
    const second = buildAnnouncement({ title: 'Второе', text: 'т', days: 7 }, NOW + 1000)
    await writeAnnouncement(r, second, NOW + 1000)
    expect((await readAnnouncement(r, NOW + 1000))?.title).toBe('Второе')
  })

  it('истёкшее НЕ отдаётся, даже если ключ ещё жив', async () => {
    // Redis удаляет по сроку с задержкой, и минуту-другую после конца акции ключ читается.
    const r = memoryAnnouncementRedis()
    const a = make(1)
    await writeAnnouncement(r, a, NOW)
    expect(await readAnnouncement(r, NOW + 2 * 24 * 3600 * 1000)).toBeNull()
  })

  it('истёкшее не записывается вовсе', async () => {
    const r = memoryAnnouncementRedis()
    expect(await writeAnnouncement(r, make(1), NOW + 5 * 24 * 3600 * 1000)).toBe(false)
  })

  it('без хранилища — честное «не сохранилось», а не тихий успех', async () => {
    // Оператор иначе ждал бы реакции клиентов на рассылку, которой не было.
    expect(await writeAnnouncement(null, make(), NOW)).toBe(false)
    expect(await clearAnnouncement(null)).toBe(false)
    expect(await readAnnouncement(null, NOW)).toBeNull()
  })

  it('недоступное хранилище не роняет экран, а даёт «объявления нет»', async () => {
    const log = vi.fn()
    const broken = {
      get: async () => {
        throw new Error('нет связи')
      },
      set: async () => {},
      del: async () => {}
    }
    expect(await readAnnouncement(broken, NOW, log)).toBeNull()
    expect(log).toHaveBeenCalled()
  })

  it('битое значение читается как «нет объявления»', async () => {
    const r = memoryAnnouncementRedis()
    await r.set(ANNOUNCEMENT_KEY, 'не json', 60)
    expect(await readAnnouncement(r, NOW)).toBeNull()
  })

  it('снятое объявление больше не отдаётся', async () => {
    const r = memoryAnnouncementRedis()
    await writeAnnouncement(r, make(), NOW)
    expect(await clearAnnouncement(r)).toBe(true)
    expect(await readAnnouncement(r, NOW)).toBeNull()
  })
})
