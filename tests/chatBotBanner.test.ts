import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { botIsReady } from '../server/utils/chatBot'
import { shouldWarnUnsignedChat } from '../app/utils/chatBotBanner'

// #360: без бота сообщения уходят, но подписаны сотрудником. Предупреждать об этом надо ровно там,
// где это правда и где на это можно повлиять — иначе баннер станет фоном, который перестают читать.
const base = { screen: 'work', isAdmin: true, botReady: false, notifyChatId: 'chat5' }

describe('предупреждение «сообщения подписаны сотрудником»', () => {
  it('показываем администратору на рабочем экране, когда бота нет, а чат настроен', () => {
    expect(shouldWarnUnsignedChat(base)).toBe(true)
  })

  it('бот есть — молчим', () => {
    expect(shouldWarnUnsignedChat({ ...base, botReady: true })).toBe(false)
  })

  it('не администратору не показываем — он всё равно не сменит тариф портала', () => {
    expect(shouldWarnUnsignedChat({ ...base, isAdmin: false })).toBe(false)
  })

  it('чат уведомлений не настроен — сообщений нет вовсе, предупреждать не о чем', () => {
    // Самое вероятное «упрощение» на ревью: убрать это условие. Тогда баннер вылезал бы на порталах,
    // которые ни одного сообщения не отправляют.
    for (const empty of [undefined, null, '']) {
      expect(shouldWarnUnsignedChat({ ...base, notifyChatId: empty }), String(empty)).toBe(false)
    }
  })

  it('на экране настройки молчим — там уже висит баннер про саму настройку', () => {
    for (const screen of ['setup', 'loading', 'launch']) {
      expect(shouldWarnUnsignedChat({ ...base, screen }), screen).toBe(false)
    }
  })
})

describe('серверный ответ «есть ли бот»', () => {
  it('бот есть только при положительном id', () => {
    // Инверсия этого сравнения молча перевернула бы баннер на всех порталах сразу, а вживую его
    // никто не проверял — поэтому правило живёт одной функцией, а не выражением внутри роута.
    expect(botIsReady(456)).toBe(true)
    expect(botIsReady(0)).toBe(false)
    expect(botIsReady(-1)).toBe(false)
    expect(botIsReady(Number.NaN)).toBe(false)
  })

  it('роут не считает готовность сам — зовёт общую функцию', () => {
    const route = readFileSync(new URL('../server/api/chat-bot-status.get.ts', import.meta.url), 'utf8')
    expect(route).toContain('botIsReady(')
    expect(route, 'сравнение прямо в роуте — это второй источник правды').not.toMatch(/getBotId\([^)]*\)\s*\)?\s*[<>]/)
  })

  it('без базы отвечаем «бот есть» — молчим, а не обвиняем здоровый портал', () => {
    const route = readFileSync(new URL('../server/api/chat-bot-status.get.ts', import.meta.url), 'utf8')
    expect(route).toMatch(/if \(!dbEnabled\(\)\) return \{ ready: true \}/)
  })
})
