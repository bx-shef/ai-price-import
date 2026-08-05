import { describe, expect, it } from 'vitest'
import { screenState } from '../app/utils/screenState'

// #408. Экран не вправе утверждать то, чего ещё не знает: нули метрик человек читает как факт о
// своём портале, а значения по умолчанию в настройках — как сброс конфигурации записи в CRM.

describe('#408: состояние экрана', () => {
  it('первая попытка не завершилась — грузим', () => {
    expect(screenState({ loaded: false })).toBe('loading')
  })

  it('ошибка ДО завершения первой попытки не показывается', () => {
    // ⚠ Порядок проверок: пока попытка идёт, новая ошибка возникнуть не могла, а прошлая уже
    // неактуальна. Обратный порядок рисовал бы отказ предыдущей попытки поверх идущей загрузки.
    expect(screenState({ loaded: false, error: 'старая ошибка' })).toBe('loading')
  })

  it('загрузилось с ошибкой — отказ, а не вечный скелетон', () => {
    // «Грузится» и «не загрузилось» человек обязан различить, иначе он ждёт бесконечно.
    expect(screenState({ loaded: true, error: 'нет связи' })).toBe('error')
  })

  it('загрузилось без ошибки — показываем содержимое', () => {
    expect(screenState({ loaded: true, error: '' })).toBe('ready')
    expect(screenState({ loaded: true, error: null })).toBe('ready')
  })

  it('вне портала загрузки не будет никогда — не держим человека в скелетоне', () => {
    // Фрейм-токена нет ⇒ запрос не уйдёт ⇒ `loaded` не станет true. Без этой ветки страница вне
    // портала показывала бы заглушку вечно. Предпросмотр — не отказ.
    expect(screenState({ loaded: false, inert: true })).toBe('ready')
    expect(screenState({ loaded: false, inert: true, error: 'x' })).toBe('ready')
  })
})
