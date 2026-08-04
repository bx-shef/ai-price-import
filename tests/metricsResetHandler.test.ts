import { describe, expect, it, vi } from 'vitest'
import { handleMetricsReset } from '../server/utils/metricsResetHandler'

// #411. Поведенческая проверка вместо проверки написания.
//
// ⚠ Несущее утверждение здесь — «разрушительный вызов НЕ состоялся». Прежний гард сторожил текст
// роута и по построению был слеп к двум мутациям, каждая из которых полностью снимает защиту:
// инверсия условия (администратор получает отказ, а любой сотрудник обнуляет пожизненные счётчики
// портала) и потерянный `return` (обнуление происходит, а ответ и телеметрия сообщают «отказано» —
// худший исход: разрушение есть, а в журнале его нет). Обе сохраняют все искомые подстроки.
const ADMIN = { ok: true as const, memberId: 'm1', admin: true }

describe('#411: обнуление счётчиков — только администратору', () => {
  it('администратор: счётчики его портала обнуляются', async () => {
    const reset = vi.fn(async () => {})
    const r = await handleMetricsReset({ member: ADMIN, reset })
    expect(r.status).toBe(200)
    expect(reset).toHaveBeenCalledExactlyOnceWith('m1')
  })

  it('не-админ: отказ, и обнуления НЕ происходит', async () => {
    const reset = vi.fn(async () => {})
    const r = await handleMetricsReset({ member: { ok: true, memberId: 'm1', admin: false }, reset })
    expect(r.status).toBe(403)
    expect(r.outcome).toBe('forbidden')
    expect(reset, 'счётчики обнулены при отказе').not.toHaveBeenCalled()
  })

  it('признак админа не булев — считаем не-админом', async () => {
    // Значение приходит из ответа портала. Строка «N» истинна, и проверка «на правдивость» вместо
    // строгой выдала бы кнопку и право не тому.
    const reset = vi.fn(async () => {})
    const r = await handleMetricsReset({ member: { ok: true, memberId: 'm1', admin: 'N' } as never, reset })
    expect(r.status).toBe(403)
    expect(reset).not.toHaveBeenCalled()
  })

  it('токена нет вовсе — 401 без обнуления', async () => {
    const reset = vi.fn(async () => {})
    const r = await handleMetricsReset({ member: null, reset })
    expect(r.status).toBe(401)
    expect(reset).not.toHaveBeenCalled()
  })

  it('токен отвергнут порталом — код портала, без обнуления', async () => {
    const reset = vi.fn(async () => {})
    const r = await handleMetricsReset({ member: { ok: false, status: 502, reason: 'transport' }, reset })
    expect(r.status).toBe(502)
    expect(r.outcome).toBe('auth_failed')
    expect(reset).not.toHaveBeenCalled()
  })

  it('администратор без member_id — не обнуляем ничего', async () => {
    // Иначе `reset(undefined)` ушёл бы в запрос без области видимости портала.
    const reset = vi.fn(async () => {})
    const r = await handleMetricsReset({ member: { ok: true, admin: true }, reset })
    expect(r.status).toBe(401)
    expect(reset).not.toHaveBeenCalled()
  })
})
