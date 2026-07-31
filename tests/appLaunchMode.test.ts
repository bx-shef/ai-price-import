import { describe, expect, it } from 'vitest'
import { appLaunchMode } from '../app/utils/appLaunchMode'

// Ровно одно сочетание даёт пусковую страницу — базовый фрейм портала. Тест перебирает остальные,
// потому что ошибка здесь стоит дорого в обе стороны: лишний лаунчер = приложением не пользуются,
// пропущенный = рабочий экран крутится в двух фреймах разом.
describe('appLaunchMode', () => {
  it('базовый фрейм портала → пусковая страница', () => {
    expect(appLaunchMode({ inFrame: true })).toBe('launcher')
    expect(appLaunchMode({ inFrame: true, place: '', sliderMode: false, isMobile: false })).toBe('launcher')
  })
  it('наш слайдер (по place) → рабочий экран, второй слайдер не открываем', () => {
    expect(appLaunchMode({ inFrame: true, place: 'app-main' })).toBe('work')
    expect(appLaunchMode({ inFrame: true, place: 'app-options' })).toBe('work')
  })
  it('слайдер без нашего place (признак IFRAME) → рабочий экран', () => {
    expect(appLaunchMode({ inFrame: true, sliderMode: true })).toBe('work')
  })
  it('мобильное приложение → рабочий экран', () => {
    expect(appLaunchMode({ inFrame: true, isMobile: true })).toBe('work')
  })
  it('вне портала → рабочий экран (слайдер открыть нечем)', () => {
    expect(appLaunchMode({ inFrame: false })).toBe('work')
  })
})
