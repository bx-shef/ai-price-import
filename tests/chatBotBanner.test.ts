import { describe, expect, it } from 'vitest'
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
