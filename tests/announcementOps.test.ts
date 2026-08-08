import { describe, expect, it, vi } from 'vitest'
import { handleAnnouncementOp } from '../server/utils/announcementOpsHandler'

const NOW = Date.parse('2026-08-08T12:00:00Z')
const draft = { title: 'Акция', text: 'Скидка 30% до конца месяца', days: 7 }
const fx = (over: Record<string, unknown> = {}) => ({
  publish: vi.fn(async () => true),
  clear: vi.fn(async () => true),
  now: () => NOW,
  ...over
})

describe('консоль оператора: объявление', () => {
  it('предпросмотр показывает объявление и НИЧЕГО не отправляет', async () => {
    const f = fx()
    const r = await handleAnnouncementOp('preview', draft, undefined, f)
    expect(r.status).toBe(200)
    expect((r.body.preview as { title: string }).title).toBe('Акция')
    expect(f.publish).not.toHaveBeenCalled()
  })

  it('публикация БЕЗ подтверждения не отправляет ничего', async () => {
    // Второй шаг серверный: два клика в интерфейсе исчезают вместе с вкладкой, роут остаётся.
    const f = fx()
    const r = await handleAnnouncementOp('publish', draft, undefined, f)
    expect(r.status).toBe(409)
    expect(f.publish).not.toHaveBeenCalled()
    expect(String(r.body.error)).toMatch(/нельзя отозвать/)
  })

  it('подтверждённая публикация уходит', async () => {
    const f = fx()
    const r = await handleAnnouncementOp('publish', draft, true, f)
    expect(r.status).toBe(200)
    expect(f.publish).toHaveBeenCalledTimes(1)
  })

  it('негодный черновик отвергается ДО записи и с причинами', async () => {
    const f = fx()
    const r = await handleAnnouncementOp('publish', { title: '', text: '', days: 0 }, true, f)
    expect(r.status).toBe(400)
    expect((r.body.problems as string[]).length).toBeGreaterThan(1)
    expect(f.publish).not.toHaveBeenCalled()
  })

  it('неудачная запись — 503 и прямая формулировка, а не тихий успех', async () => {
    // Молчаливый «ок» означал бы, что владелец ждёт реакции клиентов на рассылку, которой не было.
    const f = fx({ publish: vi.fn(async () => false) })
    const r = await handleAnnouncementOp('publish', draft, true, f)
    expect(r.status).toBe(503)
    expect(String(r.body.error)).toMatch(/НЕ отправлено/)
  })

  it('снятие подтверждения не требует — оно ничего не разрушает наружу', async () => {
    const f = fx()
    expect((await handleAnnouncementOp('clear', {}, undefined, f)).status).toBe(200)
    expect(f.clear).toHaveBeenCalled()
  })

  it('неудачное снятие тоже говорится вслух', async () => {
    const f = fx({ clear: vi.fn(async () => false) })
    expect((await handleAnnouncementOp('clear', {}, undefined, f)).status).toBe(503)
  })

  it('неизвестное действие — 400, без эффектов', async () => {
    const f = fx()
    expect((await handleAnnouncementOp('send-all', draft, true, f)).status).toBe(400)
    expect(f.publish).not.toHaveBeenCalled()
    expect(f.clear).not.toHaveBeenCalled()
  })
})
