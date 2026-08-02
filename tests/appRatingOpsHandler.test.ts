import { describe, expect, it, vi } from 'vitest'
import { handleAppRatingOp } from '../server/utils/appRatingOpsHandler'
import { clearReviewed } from '../server/utils/appRatingStore'

const OK_ID = 'a1b2c3d4e5f6'

function deps() {
  return { markReviewed: vi.fn(async () => {}), reset: vi.fn(async () => {}), unreview: vi.fn(async () => {}) }
}

describe('handleAppRatingOp', () => {
  it('rejects a non-hex memberId (before any write)', async () => {
    const d = deps()
    const r = await handleAppRatingOp('../etc', 'reviewed', d)
    expect(r.status).toBe(400)
    expect(d.markReviewed).not.toHaveBeenCalled()
    expect(d.reset).not.toHaveBeenCalled()
  })

  it('rejects an unknown action', async () => {
    const d = deps()
    const r = await handleAppRatingOp(OK_ID, 'delete', d)
    expect(r.status).toBe(400)
    expect(d.markReviewed).not.toHaveBeenCalled()
  })

  it('dispatches reviewed → markReviewed', async () => {
    const d = deps()
    const r = await handleAppRatingOp(OK_ID, 'reviewed', d)
    expect(r).toEqual({ status: 200, body: { ok: true, action: 'reviewed' } })
    expect(d.markReviewed).toHaveBeenCalledWith(OK_ID)
    expect(d.reset).not.toHaveBeenCalled()
  })

  it('dispatches reset → reset', async () => {
    const d = deps()
    const r = await handleAppRatingOp(`  ${OK_ID}  `, 'reset', d)
    expect(r.status).toBe(200)
    expect(d.reset).toHaveBeenCalledWith(OK_ID) // trimmed
    expect(d.markReviewed).not.toHaveBeenCalled()
  })

  // #318 п.2: «отзыв оставлен» перестал быть тупиком. Ошибочный клик раньше откатывался только
  // через базу, а ошибаются в этой консоли легко: строки идут подряд, кнопки рядом.
  it('dispatches unreview → unreview, and NOT reset', async () => {
    // Разные действия: `reset` чистит показы (попап вернётся по обычному правилу), `unreview`
    // снимает саму отметку об отзыве. Свести их в одно — значит потерять состояние показов.
    const d = deps()
    const r = await handleAppRatingOp(OK_ID, 'unreview', d)
    expect(r).toEqual({ status: 200, body: { ok: true, action: 'unreview' } })
    expect(d.unreview).toHaveBeenCalledWith(OK_ID)
    expect(d.reset).not.toHaveBeenCalled()
    expect(d.markReviewed).not.toHaveBeenCalled()
  })
})

describe('SQL отмены подтверждения (#318 п.2)', () => {
  it('снимает только отметку отзыва и не трогает показы', async () => {
    // Возврат «в состояние ДО подтверждения» — значит prompted_at/opened_at остаются как были, и
    // попап покажется, когда подойдёт обычный срок, а не сразу. Сброс этих меток здесь был бы
    // другим действием (`reset`), и объединять их нельзя.
    const query = vi.fn().mockResolvedValue({ rows: [] })
    await clearReviewed(OK_ID, query)
    const sql = String(query.mock.calls[0]![0])
    expect(sql).toMatch(/^UPDATE/i)
    expect(sql).toMatch(/reviewed\s*=\s*false/i)
    expect(sql).not.toMatch(/opened_at\s*=\s*NULL/i)
    expect(sql).not.toMatch(/prompted_at\s*=\s*NULL/i)
    expect(query.mock.calls[0]![1]).toEqual([OK_ID])
  })

  it('действует на свой портал, а не на все сразу', () => {
    // Забытый WHERE снял бы отметку у всех порталов разом — молча и необратимо.
    const query = vi.fn().mockResolvedValue({ rows: [] })
    void clearReviewed(OK_ID, query)
    expect(String(query.mock.calls[0]![0])).toMatch(/WHERE member_id = \$1/)
  })
})
