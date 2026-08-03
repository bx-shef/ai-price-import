import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RATING_MIN_INSTALL_AGE_DAYS, RATING_REPROMPT_DAYS, shouldPrompt } from '../server/utils/appRatingPolicy'

const NOW = new Date('2026-07-19T12:00:00Z')
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000)
/** Портал, установленный давно: возраст перестал быть ограничением, проверяем остальные правила. */
const OLD = daysAgo(365)

describe('shouldPrompt', () => {
  it('shows when there is no row yet (first-ever)', () => {
    expect(shouldPrompt(null, NOW, { installedAt: OLD })).toBe(true)
  })

  it('shows when a row exists but was never actually prompted', () => {
    expect(shouldPrompt({ promptedAt: null, openedAt: null, reviewed: false }, NOW, { installedAt: OLD })).toBe(true)
  })

  it('never shows once a review is confirmed', () => {
    expect(shouldPrompt({ promptedAt: daysAgo(999), openedAt: null, reviewed: true }, NOW, { installedAt: OLD })).toBe(false)
  })

  it('suppresses while opened_at is set (awaiting manual verification)', () => {
    expect(shouldPrompt({ promptedAt: daysAgo(999), openedAt: daysAgo(1), reviewed: false }, NOW, { installedAt: OLD })).toBe(false)
  })

  it('throttles: hidden within the re-prompt interval', () => {
    expect(shouldPrompt({ promptedAt: daysAgo(RATING_REPROMPT_DAYS - 1), openedAt: null, reviewed: false }, NOW, { installedAt: OLD })).toBe(false)
  })

  it('shows again once the re-prompt interval has elapsed', () => {
    expect(shouldPrompt({ promptedAt: daysAgo(RATING_REPROMPT_DAYS), openedAt: null, reviewed: false }, NOW, { installedAt: OLD })).toBe(true)
  })

  it('honours a custom re-prompt interval', () => {
    const st = { promptedAt: daysAgo(2), openedAt: null, reviewed: false }
    expect(shouldPrompt(st, NOW, { repromptDays: 1, installedAt: OLD })).toBe(true)
    expect(shouldPrompt(st, NOW, { repromptDays: 3, installedAt: OLD })).toBe(false)
  })
})

describe('#380: попап не раньше N суток после установки', () => {
  const fresh = { promptedAt: null, openedAt: null, reviewed: false }

  it('портал моложе порога попапа не получает', () => {
    // Сценарий из issue: установили, через десять минут провели первый успешный импорт — и получили
    // просьбу об оценке. Человек видел продукт один раз, а второй попытки почти нет: клик «Оценить»
    // глушит попап до ручной проверки.
    expect(shouldPrompt(fresh, NOW, { installedAt: daysAgo(RATING_MIN_INSTALL_AGE_DAYS - 1) })).toBe(false)
    expect(shouldPrompt(null, NOW, { installedAt: daysAgo(0) })).toBe(false)
  })

  it('на N-е сутки появляется на первом же успешном импорте', () => {
    expect(shouldPrompt(fresh, NOW, { installedAt: daysAgo(RATING_MIN_INSTALL_AGE_DAYS) })).toBe(true)
    expect(shouldPrompt(null, NOW, { installedAt: daysAgo(RATING_MIN_INSTALL_AGE_DAYS) })).toBe(true)
  })

  it('возраст неизвестен → НЕ показываем', () => {
    // Строки токенов может не быть (гонка установки, очистка). Цена ошибки несимметрична:
    // преждевременный показ тратит единственную попытку, поздний стоит нескольких дней.
    expect(shouldPrompt(fresh, NOW, { installedAt: null })).toBe(false)
    expect(shouldPrompt(fresh, NOW, { installedAt: undefined })).toBe(false)
    expect(shouldPrompt(null, NOW, { installedAt: null })).toBe(false)
  })

  it('возраст — ОТДЕЛЬНОЕ условие, а не замена прежним', () => {
    // Старый портал всё равно молчит, если отзыв подтверждён или ждём ручной проверки.
    expect(shouldPrompt({ promptedAt: daysAgo(999), openedAt: null, reviewed: true }, NOW, { installedAt: OLD })).toBe(false)
    expect(shouldPrompt({ promptedAt: daysAgo(999), openedAt: daysAgo(1), reviewed: false }, NOW, { installedAt: OLD })).toBe(false)
    expect(shouldPrompt({ promptedAt: daysAgo(1), openedAt: null, reviewed: false }, NOW, { installedAt: OLD })).toBe(false)
  })

  it('два срока — две независимые константы', () => {
    // Сегодня оба равны четырём, и это совпадение: «не чаще раза в N дней» и «не раньше N суток от
    // установки» — разные смыслы. Одна константа связала бы их навсегда.
    const st = { promptedAt: null, openedAt: null, reviewed: false }
    expect(shouldPrompt(st, NOW, { minInstallAgeDays: 1, installedAt: daysAgo(2) })).toBe(true)
    expect(shouldPrompt(st, NOW, { minInstallAgeDays: 10, installedAt: daysAgo(2) })).toBe(false)
    // Троттл при этом не трогается: свежепоказанный попап молчит на любом возрасте установки.
    expect(shouldPrompt({ promptedAt: daysAgo(1), openedAt: null, reviewed: false }, NOW, { minInstallAgeDays: 0, installedAt: daysAgo(365) })).toBe(false)
  })
})

describe('#380 ревью: то, что держалось только на комментарии', () => {
  it('возрастной гейт стоит ПЕРЕД разбором строки, а не после', () => {
    // Мутация «перенести гейт под `if (!state)`» проходила при всех зелёных тестах. Отказ узкий, но
    // реальный: у молодого портала строка `portal_app_rating` может уже существовать — её заводит
    // консоль оператора (`markReviewed`/`clearOpened`), — и тогда решение уходило по прежней ветке
    // троттла, то есть попап всплывал на первые сутки.
    const rowWithExpiredThrottle = { promptedAt: daysAgo(RATING_REPROMPT_DAYS + 1), openedAt: null, reviewed: false }
    expect(shouldPrompt(rowWithExpiredThrottle, NOW, { installedAt: daysAgo(1) })).toBe(false)
  })

  it('две константы независимы ПО ПОСТРОЕНИЮ, а не по совпадению значений', () => {
    // Требование приёмки. Числа сегодня равны, поэтому мутация «RATING_MIN_INSTALL_AGE_DAYS =
    // RATING_REPROMPT_DAYS» не роняла ничего — проверить это можно только структурно.
    const src = readFileSync(new URL('../server/utils/appRatingPolicy.ts', import.meta.url), 'utf8')
    const decl = src.match(/export const RATING_MIN_INSTALL_AGE_DAYS\s*=\s*([^\n]+)/)?.[1] ?? ''
    expect(decl, 'порог установки выражен через троттл — смыслы связаны навсегда').not.toMatch(/RATING_REPROMPT_DAYS/)
    expect(decl.trim()).toMatch(/^\d+$/)
    // И обратно: троттл не должен быть выражен через порог установки.
    const throttle = src.match(/export const RATING_REPROMPT_DAYS\s*=\s*([^\n]+)/)?.[1] ?? ''
    expect(throttle).not.toMatch(/RATING_MIN_INSTALL_AGE_DAYS/)
  })
})

describe('#380 ревью: шов «роут → политика»', () => {
  // Мутация «передать в политику фиксированную старую дату» (то есть выключить фичу) не роняла
  // НИЧЕГО: политика покрыта плотно, чтение даты теперь тоже, а вот то, что роут действительно
  // отдаёт прочитанное, не проверял никто. Тот же класс, что уже закрывали у лимитера загрузок.
  const src = readFileSync(new URL('../server/api/app-rating.get.ts', import.meta.url), 'utf8')
  const body = src.split('\n').filter(l => !/^\s*import\b/.test(l)).join('\n')

  it('роут читает дату установки и отдаёт её в решение', () => {
    expect(body).toMatch(/getInstalledAt\(/)
    expect(body).toMatch(/shouldPrompt\([\s\S]{0,120}?installedAt/)
  })

  it('не подменяет её константой', () => {
    // `new Date(0)` / литерал даты рядом с вызовом означал бы «портал всегда старый».
    const call = body.slice(body.indexOf('shouldPrompt('), body.indexOf('shouldPrompt(') + 200)
    expect(call).not.toMatch(/installedAt:\s*new Date\(/)
  })

  it('сбой чтения не остаётся немым', () => {
    // Перманентный отказ SELECT’а навсегда выключил бы попап без единой строки в журнале.
    expect(body).toMatch(/getInstalledAt[\s\S]{0,300}console\.warn/)
  })
})
