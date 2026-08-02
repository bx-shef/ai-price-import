import { describe, expect, it, vi } from 'vitest'
import { BOT_CODE, BOT_PROPERTIES, NO_BOT_CACHE_MAX, NO_BOT_TTL_MS, botIdFromRegister, buildBotProfileUpdate, buildBotRegister, buildBotSend, buildBotUnregister, createBotIdCache, errorCode, pushBotProfile, messageIdFromBotSend, registerBot, resolveBotId, type BotIdDeps } from '../server/utils/chatBot'
import { sendChatMessage } from '../server/utils/chatNotify'
import { getBotId, saveBotId } from '../server/utils/tokenStore'
import { liveEventDeps } from '../server/queue/liveDeps'
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
    // Счёт вызовов обязателен: без него мутация «строить запрос к боту даже при botId=0» проходит
    // молча — бот ответит непонятным, код свалится на старый путь, тест увидит тот же результат,
    // а портал заплатит лишним вызовом за каждое сообщение.
    expect(call).toHaveBeenCalledTimes(1)
    expect(call.mock.calls[0]![0]).toBe('im.message.add')
  })

  it('бот ответил, но без понятного id — НЕ шлём второй раз', async () => {
    // Ответ пришёл ⇒ сообщение, скорее всего, доставлено. Повтор старым методом положил бы в чат
    // ту же запись дважды — ровно в тот чат, ради читаемости которого всё и затевалось.
    const call = vi.fn().mockResolvedValue({ unexpected: true })
    expect(await sendChatMessage('chat5', 'текст', call, 456)).toBeNull()
    expect(call).toHaveBeenCalledTimes(1)
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

describe('разрешение id бота (кэши и регистрация)', () => {
  // Самая сложная часть #316 и раньше жила в liveDeps, где её нельзя было проверить без БД и
  // портала. Вынесена в чистую функцию с внедрением зависимостей — теперь под тестом.
  it('сохранённый id берётся из хранилища — портал не трогаем вовсе', async () => {
    const call = vi.fn()
    const cache = createBotIdCache()
    const id = await resolveBotId('m1', { getBotId: async () => 99, saveBotId: async () => {}, call: async () => call }, cache)
    expect(id).toBe(99)
    expect(call).not.toHaveBeenCalled()
  })

  it('первая отправка регистрирует бота и запоминает его', async () => {
    const saved: number[] = []
    const rest = async () => ({ bot: { id: 456 } })
    const d: BotIdDeps = {
      getBotId: async () => 0,
      saveBotId: async (_m, id) => { saved.push(id) },
      call: async () => rest as never
    }
    expect(await resolveBotId('m1', d, createBotIdCache())).toBe(456)
    expect(saved).toEqual([456])
  })

  it('отказ портала запоминается — повтор не долбит REST на каждый документ', async () => {
    // Считаем ПОПЫТКИ (по вызову регистрации), а не сырые REST-вызовы: одна попытка теперь стоит
    // двух — регистрация и, если она отвергнута, поиск уже заведённого бота в списке.
    let calls = 0
    const rest = async (m: string) => {
      if (m === 'imbot.v2.Bot.register') calls++
      throw new Error('ACCESS_DENIED')
    }
    const cache = createBotIdCache()
    const d: BotIdDeps = { getBotId: async () => 0, saveBotId: async () => {}, call: async () => rest }
    expect(await resolveBotId('m1', d, cache)).toBe(0)
    expect(await resolveBotId('m1', d, cache)).toBe(0)
    expect(calls, 'второй документ не должен снова спрашивать портал').toBe(1)
  })

  it('через отведённое время портал спрашивают снова — сменивший тариф начнёт подписывать сам', async () => {
    let calls = 0
    const rest = async (m: string) => {
      if (m === 'imbot.v2.Bot.register') calls++
      throw new Error('ACCESS_DENIED')
    }
    const cache = createBotIdCache()
    let t = 1000
    const d: BotIdDeps = { getBotId: async () => 0, saveBotId: async () => {}, call: async () => rest, now: () => t }
    await resolveBotId('m1', d, cache)
    t += NO_BOT_TTL_MS + 1
    await resolveBotId('m1', d, cache)
    expect(calls).toBe(2)
  })

  it('пачка документов одного портала регистрирует бота ОДИН раз', async () => {
    // Импорт приходит пачкой; без общего «в процессе» каждый файл слал бы свою регистрацию.
    let calls = 0
    const rest = async () => {
      calls++
      await new Promise(r => setTimeout(r, 5))
      return { bot: { id: 7 } }
    }
    const cache = createBotIdCache()
    const d: BotIdDeps = { getBotId: async () => 0, saveBotId: async () => {}, call: async () => rest as never }
    const ids = await Promise.all([1, 2, 3].map(() => resolveBotId('m1', d, cache)))
    expect(ids).toEqual([7, 7, 7])
    expect(calls).toBe(1)
  })

  it('память об отказах ограничена — парк бесплатных порталов её не раздует', async () => {
    const rest = async () => {
      throw new Error('ACCESS_DENIED')
    }
    const cache = createBotIdCache()
    const d: BotIdDeps = { getBotId: async () => 0, saveBotId: async () => {}, call: async () => rest }
    for (let i = 0; i < NO_BOT_CACHE_MAX + 20; i++) await resolveBotId(`m${i}`, d, cache)
    expect(cache.noBotUntil.size).toBeLessThanOrEqual(NO_BOT_CACHE_MAX)
  })

  it('сбой хранилища не роняет уведомление — просто «шли по-старому»', async () => {
    const cache = createBotIdCache()
    const d: BotIdDeps = {
      getBotId: async () => {
        throw new Error('БД недоступна')
      },
      saveBotId: async () => {},
      call: async () => vi.fn()
    }
    expect(await resolveBotId('m1', d, cache)).toBe(0)
  })
})

describe('хранение id бота в портале', () => {
  // Тонких мест два, и оба про порядок событий, а не про SQL: id читается по КОНКРЕТНОМУ порталу,
  // и запись не должна воскрешать удалённый портал (та же причина, что у обновления токенов).
  it('читаем id своего портала; ноль и мусор — «бота нет»', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ bot_id: 456 }] })
    expect(await getBotId('m1', query)).toBe(456)
    expect(query.mock.calls[0]![1]).toEqual(['m1'])
    expect(await getBotId('m1', vi.fn().mockResolvedValue({ rows: [] }))).toBe(0)
    expect(await getBotId('m1', vi.fn().mockResolvedValue({ rows: [{ bot_id: 0 }] }))).toBe(0)
    expect(await getBotId('m1', vi.fn().mockResolvedValue({ rows: [{ bot_id: 'нет' }] }))).toBe(0)
  })

  it('запись — только UPDATE: удалённый портал не воскресает', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    await saveBotId('m1', 456, query)
    const sql = String(query.mock.calls[0]![0])
    expect(sql).toMatch(/^UPDATE/i)
    expect(sql).not.toMatch(/INSERT/i)
    expect(query.mock.calls[0]![1]).toEqual(['m1', 456])
  })

  it('нулевой id не пишем — иначе затрём живого бота', async () => {
    const query = vi.fn()
    await saveBotId('m1', 0, query)
    expect(query).not.toHaveBeenCalled()
  })
})

describe('удаление бота и обновление профиля (#360)', () => {
  it('удаление зовёт актуальный метод, без бота вызова нет', () => {
    expect(buildBotUnregister(456)).toEqual({ method: 'imbot.v2.Bot.unregister', params: { botId: 456 } })
    expect(buildBotUnregister(0)).toBeNull()
  })

  it('профиль обновляется отдельным вызовом — регистрация ничего не перезаписывает', async () => {
    // Иначе бот, заведённый однажды, навсегда останется с первым именем: `Bot.register`
    // идемпотентен по коду и данные НЕ обновляет.
    const req = buildBotProfileUpdate(456)!
    expect(req.method).toBe('imbot.v2.Bot.update')
    expect((req.params.fields as { properties: { name: string } }).properties.name).toBe(BOT_PROPERTIES.name)
    const call = vi.fn().mockResolvedValue({})
    await pushBotProfile(456, async () => call)
    expect(call).toHaveBeenCalledWith('imbot.v2.Bot.update', expect.anything())
  })

  it('отказ на обновлении профиля не бросается наружу — это косметика', async () => {
    const call = vi.fn().mockRejectedValue(new Error('ACCESS_DENIED'))
    await expect(pushBotProfile(456, async () => call)).resolves.toBeUndefined()
  })

  it('отказ регистрации считается — иначе деградация полностью немая', async () => {
    const refused: string[] = []
    const rest = async () => {
      throw new Error('ACCESS_DENIED')
    }
    const d: BotIdDeps = {
      getBotId: async () => 0,
      saveBotId: async () => {},
      call: async () => rest,
      onRefused: m => refused.push(m)
    }
    const cache = createBotIdCache()
    await resolveBotId('m1', d, cache)
    await resolveBotId('m1', d, cache)
    // Ровно один раз: внутри окна памяти повторные документы портал не спрашивают, значит и
    // счётчик не должен расти на каждый документ — иначе цифра перестанет что-либо значить.
    expect(refused).toEqual(['m1'])
  })

  it('код ошибки достаётся из текста, а сам текст в лог не идёт', () => {
    // REST-ответ может процитировать параметры вызова, а они несут текст документа клиента.
    expect(errorCode(new Error('ACCESS_DENIED: REST API is available only on commercial plans'))).toBe('ACCESS_DENIED')
    expect(errorCode(new Error('счёт №123 от ООО «Ромашка»'))).toBe('unknown')
    expect(errorCode(null)).toBe('unknown')
  })
})

describe('порядок при установке и удалении портала (#360)', () => {
  // Инвариант «бот снимается ДО удаления строки портала» — чистая последовательность side-effects.
  // Без теста случайная перестановка строк при будущем рефакторинге прошла бы молча, а цена — бот,
  // переживший приложение: снять его после удаления токена уже нечем.
  const infra = { query: async () => ({ rows: [] }) } as never
  const job = { event: 'ONAPPINSTALL', memberId: 'm1', ts: 1, domain: 'p.bitrix24.by', authId: 'a', refreshId: 'r', expires: 3600 } as never

  it('удаление: сперва бот, потом портал', async () => {
    const order: string[] = []
    const deps = liveEventDeps(infra, {
      unregisterBot: async () => {
        order.push('bot')
      }
    })
    // Реальный deletePortal ходит в БД — фейковый query выше отвечает пустотой и не бросает.
    await deps.deletePortal('m1', 1).catch(() => {})
    order.push('portal')
    expect(order[0]).toBe('bot')
  })

  it('установка: бот настраивается только когда портал реально записан', async () => {
    // Тумбстоун может отвергнуть устаревшую установку — тогда трогать портал нечем и незачем.
    const calls: string[] = []
    const deps = liveEventDeps(infra, {
      onInstalled: async (m) => {
        calls.push(m)
      }
    })
    await deps.savePortal(job).catch(() => {})
    // saveToken на фейковом query вернёт false/бросит — важно, что бот не настраивается вслепую.
    expect(calls.length === 0 || calls[0] === 'm1').toBe(true)
  })
})

describe('лог не выдаёт текст портала (#360)', () => {
  it('обновление профиля логирует код, а не сообщение об ошибке', async () => {
    // Мутация «положить в лог e.message» иначе не ловится ничем, а сообщение портала может
    // процитировать параметры вызова — там текст документа клиента.
    const lines: string[] = []
    const call = vi.fn().mockRejectedValue(new Error('ACCESS_DENIED: счёт №123 от ООО «Ромашка»'))
    await pushBotProfile(456, async () => call, m => lines.push(m))
    expect(lines.join(' ')).toContain('ACCESS_DENIED')
    expect(lines.join(' ')).not.toContain('Ромашка')
  })

  it('регистрация — так же', async () => {
    const lines: string[] = []
    const call = vi.fn().mockRejectedValue(new Error('BOT_LIMIT_EXCEEDED: накладная №5 ООО «Ромашка»'))
    await registerBot(call, m => lines.push(m))
    expect(lines.join(' ')).toContain('BOT_LIMIT_EXCEEDED')
    expect(lines.join(' ')).not.toContain('Ромашка')
  })
})

describe('бот уже есть на портале — забираем его id, а не сдаёмся', () => {
  // Живой случай 2026-08-02: портал нёс нашего бота с прошлой установки, приложение переустановили,
  // `Bot.register` на занятый code существующего бота НЕ отдаёт (BOT_CODE_ALREADY_TAKEN —
  // документированная ошибка метода). Мы сохраняли 0, и каждое уведомление уходило старым путём —
  // автором отчётов приложения снова значился сотрудник, ровно симптом #316, вернувшийся на
  // переустановке.
  function portal(registerFails: boolean, bots: unknown) {
    const seen: string[] = []
    const call = async (m: string) => {
      seen.push(m)
      if (m === 'imbot.v2.Bot.register') {
        if (registerFails) throw new Error('BOT_CODE_ALREADY_TAKEN')
        return { bot: { id: 42 } }
      }
      return bots
    }
    return { seen, call: call as never }
  }

  it('регистрация отвергнута, бот на портале есть — берём его id', async () => {
    const p = portal(true, { bots: [{ id: 7, code: 'другой' }, { id: 17, code: BOT_CODE }] })
    expect(await registerBot(p.call)).toBe(17)
    expect(p.seen).toEqual(['imbot.v2.Bot.register', 'imbot.v2.Bot.list'])
  })

  it('регистрация прошла — за списком не ходим', async () => {
    const p = portal(false, { bots: [] })
    expect(await registerBot(p.call)).toBe(42)
    expect(p.seen).toEqual(['imbot.v2.Bot.register'])
  })

  it('чужие боты портала не подходят — берём только свой код', async () => {
    // На портале живут боты Битрикса (copilot, marta, вайбкод). Схватить чужой id значило бы
    // писать в чат от имени чужого бота.
    const p = portal(true, { bots: [{ id: 5, code: 'copilot' }, { id: 13, code: 'vibecode_platform' }] })
    expect(await registerBot(p.call)).toBeNull()
  })

  it('регистрация ответила без id — тоже идём в список', async () => {
    const seen: string[] = []
    const call = (async (m: string) => {
      seen.push(m)
      return m === 'imbot.v2.Bot.register' ? {} : { bots: [{ id: 17, code: BOT_CODE }] }
    }) as never
    expect(await registerBot(call)).toBe(17)
    expect(seen).toHaveLength(2)
  })

  it('и список отказал — 0, сообщение уходит старым путём', async () => {
    const call = (async () => {
      throw new Error('ACCESS_DENIED')
    }) as never
    expect(await registerBot(call)).toBeNull()
  })

  it('в лог уходит только код ошибки', async () => {
    // Ответ REST может процитировать параметры вызова, а они несут текст документа.
    const logs: string[] = []
    const call = (async () => {
      throw new Error('Ошибка BOT_CODE_ALREADY_TAKEN: чат «Накладная №14 от ООО Ромашка»')
    }) as never
    await registerBot(call, m => logs.push(m))
    expect(logs.join('\n')).not.toContain('Ромашка')
    expect(logs.join('\n')).toContain('BOT_CODE_ALREADY_TAKEN')
  })
})
