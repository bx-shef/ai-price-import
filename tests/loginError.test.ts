import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RETRY_SEC,
  MAX_RETRY_SEC,
  failureStatus,
  formatWait,
  isDisabledByServer,
  isThrottled,
  loginErrorMessage,
  retryAfterSeconds
} from '../app/utils/loginError'

// #271-M: три очень разные причины отказа раньше выглядели одинаково — «Не удалось войти».
describe('loginErrorMessage', () => {
  it('401 — неверный пароль', () => {
    expect(loginErrorMessage({ status: 401, serverMessage: 'неверный пароль' })).toBe('Неверный пароль.')
  })

  it('503 — вход выключен на сервере, а не «что-то пошло не так»', () => {
    expect(loginErrorMessage({ status: 503 })).toBe('Вход выключен: пароль оператора не задан на сервере.')
  })

  it('429 — говорим про перебор и когда можно повторить', () => {
    expect(loginErrorMessage({ status: 429, retryAfterSec: 300 })).toContain('через 5 минут')
  })

  it('429 без Retry-After — подставляем короткий срок, а не молчим', () => {
    // Основной путь в проде: 429 приходит от nginx, а он заголовок не шлёт.
    expect(loginErrorMessage({ status: 429 })).toContain(`через ${DEFAULT_RETRY_SEC} с`)
  })

  it('неизвестный статус — текст сервера, иначе нейтральное про соединение', () => {
    expect(loginErrorMessage({ status: 502, serverMessage: 'bad gateway' })).toBe('bad gateway')
    expect(loginErrorMessage({})).toContain('Проверьте соединение')
    expect(loginErrorMessage({ status: 500, serverMessage: '   ' })).toContain('Проверьте соединение')
  })

  it('статус главнее текста сервера: смысл кода не меняется, формулировка может', () => {
    expect(loginErrorMessage({ status: 401, serverMessage: 'что угодно' })).toBe('Неверный пароль.')
  })

  it('текст 503 не совпадает с формулировкой спокойного предупреждения на странице', () => {
    // Один и тот же текст в жёлтом «состояние» и в красном «действие сорвалось» сбивал бы с толку.
    expect(loginErrorMessage({ status: 503 })).not.toBe('Вход оператора отключён')
  })
})

describe('retryAfterSeconds', () => {
  it('пусто или мусор → короткий запасной срок', () => {
    for (const raw of [null, undefined, 0, -5, Number.NaN, Infinity]) {
      expect(retryAfterSeconds(raw)).toBe(DEFAULT_RETRY_SEC)
    }
  })

  it('дробное округляется вверх — «ещё 0 секунд» было бы враньём', () => {
    expect(retryAfterSeconds(4.2)).toBe(5)
  })

  it('запредельное подрезается: вечная блокировка — тупик', () => {
    expect(retryAfterSeconds(99_999)).toBe(MAX_RETRY_SEC)
  })
})

describe('formatWait', () => {
  it('секунды остаются секундами — не «через минуту» на шесть секунд', () => {
    expect(formatWait(6)).toBe('через 6 с')
    expect(formatWait(59)).toBe('через 59 с')
  })

  it('минуты округляются ВВЕРХ', () => {
    // 90 с — это «через 2 минуты»; округление вниз обещало бы минуту, которой не хватит.
    expect(formatWait(90)).toBe('через 2 минуты')
    expect(formatWait(60)).toBe('через 1 минуту')
  })

  it('склонения', () => {
    expect(formatWait(300)).toBe('через 5 минут')
    expect(formatWait(180)).toBe('через 3 минуты')
  })
})

describe('классификация отказа', () => {
  it('временная блокировка — только 429', () => {
    expect(isThrottled(429)).toBe(true)
    expect(isThrottled(401)).toBe(false)
    expect(isThrottled(503)).toBe(false)
  })

  it('терминальная — только 503', () => {
    expect(isDisabledByServer(503)).toBe(true)
    expect(isDisabledByServer(429)).toBe(false)
    expect(isDisabledByServer(undefined)).toBe(false)
  })
})

describe('failureStatus', () => {
  it('находит статус, где бы транспорт его ни положил', () => {
    expect(failureStatus({ statusCode: 429 })).toBe(429)
    expect(failureStatus({ status: 401 })).toBe(401)
    expect(failureStatus({ response: { status: 503 } })).toBe(503)
  })

  it('нет статуса — undefined, а не выдуманное число', () => {
    expect(failureStatus(undefined)).toBeUndefined()
    expect(failureStatus(new Error('сеть'))).toBeUndefined()
  })
})
