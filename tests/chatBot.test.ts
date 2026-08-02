import { describe, expect, it, vi } from 'vitest'
import { BOT_CODE, botIdFromRegister, buildBotRegister, buildBotSend, messageIdFromBotSend, registerBot } from '../server/utils/chatBot'
import { sendChatMessage } from '../server/utils/chatNotify'
import { B24_REQUIRED_SCOPES } from '../app/config/b24'

// #316: сообщения приходили от имени сотрудника, чьим токеном приложение ходит в портал — отчёты
// об импорте выглядели так, будто их пишет коллега, а сообщение об отказе приходило сотруднику
// от самого себя. Лечится зарегистрированным чат-ботом.

describe('регистрация бота', () => {
  it('зовём АКТУАЛЬНЫЙ метод, а не устаревший', () => {
    // `imbot.register` и `imbot.message.add` помечены DEPRECATED — тянуть их в новый код нельзя.
    expect(buildBotRegister().method).toBe('imbot.v2.Bot.register')
    expect(buildBotSend(1, 'chat1', 'привет')!.method).toBe('imbot.v2.Chat.Message.send')
  })

  it('под OAuth токен бота не шлём — он только для вебхуков', () => {
    expect(JSON.stringify(buildBotRegister())).not.toContain('botToken')
  })

  it('код бота задан — он же ключ идемпотентности повторной регистрации', () => {
    const fields = buildBotRegister().params.fields as Record<string, unknown>
    expect(fields.code).toBe(BOT_CODE)
    expect(fields.properties).toBeTruthy() // без properties портал откажет
    expect(fields.eventMode).toBe('fetch') // входящие события не обрабатываем, webhookUrl не нужен
  })

  it('id бота достаётся из ответа, мусор читается как «бота нет»', () => {
    expect(botIdFromRegister({ bot: { id: 456 } })).toBe(456)
    for (const junk of [null, {}, { bot: {} }, { bot: { id: 0 } }, { bot: { id: 'нет' } }]) {
      expect(botIdFromRegister(junk), JSON.stringify(junk)).toBeNull()
    }
  })

  it('отказ портала не бросает исключение — портал просто остаётся без бота', async () => {
    // ACCESS_DENIED (бесплатный тариф) и BOT_LIMIT_EXCEEDED — штатные ответы, а не аварии.
    const call = vi.fn().mockRejectedValue(new Error('ACCESS_DENIED'))
    expect(await registerBot(call)).toBeNull()
  })
})

describe('отправка сообщения', () => {
  it('с ботом уходит от имени приложения', async () => {
    const call = vi.fn().mockResolvedValue({ id: 77 })
    expect(await sendChatMessage('chat5', 'текст', call, 456)).toBe(77)
    expect(call).toHaveBeenCalledWith('imbot.v2.Chat.Message.send', expect.objectContaining({ botId: 456, dialogId: 'chat5' }))
    expect(call).toHaveBeenCalledTimes(1) // старый метод не дёргаем
  })

  it('идентификатор диалога не меняет формата — хранимые настройки мигрировать не надо', () => {
    const params = buildBotSend(1, 'chat20921', 'x')!.params
    expect(params.dialogId).toBe('chat20921')
    expect(buildBotSend(1, '15', 'x')!.params.dialogId).toBe('15') // личный диалог — голый id
  })

  it('предпросмотр ссылок выключен, как и на старом пути', () => {
    const fields = buildBotSend(1, 'chat1', 'x')!.params.fields as Record<string, unknown>
    expect(fields.urlPreview).toBe(false)
  })

  it('без бота уходит по-старому — сообщение важнее авторства', async () => {
    const call = vi.fn().mockResolvedValue(42)
    expect(await sendChatMessage('chat5', 'текст', call)).toBe(42)
    expect(call).toHaveBeenCalledWith('im.message.add', expect.objectContaining({ DIALOG_ID: 'chat5' }))
  })

  it('отказ бота — фолбэк на старый путь, а не потерянное сообщение', async () => {
    // Главный сценарий: портал на бесплатном тарифе или установлен до появления скоупа `imbot`.
    // Сообщение об отказе — единственный канал до сотрудника (#288), молчать нельзя.
    const call = vi.fn()
      .mockRejectedValueOnce(new Error('ACCESS_DENIED'))
      .mockResolvedValueOnce(42)
    expect(await sendChatMessage('chat5', 'текст', call, 456)).toBe(42)
    expect(call.mock.calls[0]![0]).toBe('imbot.v2.Chat.Message.send')
    expect(call.mock.calls[1]![0]).toBe('im.message.add')
  })

  it('бот ответил без id — тоже фолбэк, а не мнимая отправка', async () => {
    const call = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce(42)
    expect(await sendChatMessage('chat5', 'текст', call, 456)).toBe(42)
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('пустой текст или пустой диалог не порождают вызова', async () => {
    const call = vi.fn()
    expect(await sendChatMessage('', 'текст', call, 456)).toBeNull()
    expect(await sendChatMessage('chat5', '   ', call, 456)).toBeNull()
    expect(call).not.toHaveBeenCalled()
    expect(buildBotSend(0, 'chat5', 'текст')).toBeNull() // нет бота — нет вызова
  })

  it('id сообщения достаётся из ответа', () => {
    expect(messageIdFromBotSend({ id: 5 })).toBe(5)
    expect(messageIdFromBotSend({})).toBeNull()
  })
})

describe('скоуп', () => {
  it('imbot запрошен — без него регистрация невозможна в принципе', () => {
    expect(B24_REQUIRED_SCOPES).toContain('imbot')
    expect(B24_REQUIRED_SCOPES).toContain('im') // старый путь остаётся фолбэком
  })
})
