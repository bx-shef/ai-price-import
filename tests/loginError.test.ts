import { describe, expect, it } from 'vitest'
import { isLockedOut, loginErrorMessage } from '../app/utils/loginError'

// #271-M: три очень разные причины отказа раньше выглядели одинаково — «Не удалось войти».
describe('loginErrorMessage', () => {
  it('401 — неверный пароль', () => {
    expect(loginErrorMessage({ status: 401, serverMessage: 'неверный пароль' })).toBe('Неверный пароль.')
  })

  it('503 — вход выключен администратором, а не «что-то пошло не так»', () => {
    expect(loginErrorMessage({ status: 503 })).toContain('отключён администратором')
  })

  it('429 — говорим про перебор и когда можно повторить', () => {
    const m = loginErrorMessage({ status: 429, retryAfterSec: 300 })
    expect(m).toContain('Слишком много попыток')
    expect(m).toContain('через 5 мин')
  })

  it('429 без Retry-After — всё равно объясняем, а не молчим', () => {
    const m = loginErrorMessage({ status: 429 })
    expect(m).toContain('Слишком много попыток')
    expect(m).toContain('Подождите')
  })

  it('429 с коротким ожиданием округляется до минуты', () => {
    expect(loginErrorMessage({ status: 429, retryAfterSec: 20 })).toContain('через минуту')
  })

  it('мусорный Retry-After не ломает текст', () => {
    for (const retryAfterSec of [0, -5, Number.NaN, null]) {
      expect(loginErrorMessage({ status: 429, retryAfterSec })).toContain('Подождите')
    }
  })

  it('неизвестный статус — текст сервера, иначе нейтральное про соединение', () => {
    expect(loginErrorMessage({ status: 502, serverMessage: 'bad gateway' })).toBe('bad gateway')
    expect(loginErrorMessage({})).toContain('Проверьте соединение')
    expect(loginErrorMessage({ status: 500, serverMessage: '   ' })).toContain('Проверьте соединение')
  })

  it('статус главнее текста сервера: смысл кода не меняется, формулировка может', () => {
    expect(loginErrorMessage({ status: 401, serverMessage: 'что угодно' })).toBe('Неверный пароль.')
  })
})

describe('isLockedOut', () => {
  it('только 429 глушит форму', () => {
    expect(isLockedOut(429)).toBe(true)
    expect(isLockedOut(401)).toBe(false)
    expect(isLockedOut(503)).toBe(false)
    expect(isLockedOut(undefined)).toBe(false)
  })
})
