import { describe, expect, it } from 'vitest'
import {
  MIN_REANNOUNCE_MS,
  alertMessage,
  emptyDeliveryState,
  episodeKey,
  markAnnounced,
  markRecovered,
  planAlertDelivery,
  recoveryMessage,
  type DeliveryState
} from '../server/utils/queueAlertDeliver'
import {
  MAX_TELEGRAM_TEXT,
  TELEGRAM_TIMEOUT_MS,
  resolveTelegramConfig,
  sendTelegramAlert,
  type TelegramConfig
} from '../server/utils/telegramAlert'
import { ALL_QUEUES, evaluateQueueHealth, type QueueAlert } from '../server/utils/queueAlert'

const stalled = (queue = 'crm-sync'): QueueAlert => ({ kind: 'stalled', queue, text: `очередь «${queue}» не разгребается` })
const failing = (queue = 'crm-sync'): QueueAlert => ({ kind: 'failing', queue, text: `очередь «${queue}»: 20 задач упало` })

const T = 1_000_000_000

/** Один замер: посчитать план и отметить всё отправленным (успешная доставка).
 *
 * ⚠ Отмечаются ОБА исхода — и тревога, и восстановление. Помощник обязан вести себя как настоящий
 * отправитель (`server/plugins/queue.ts`): с тех пор как ключ выбывает из ожидания только по факту
 * доставки, помощник, отмечающий одни тревоги, моделировал бы вечно падающий Телеграм. */
function tick(state: DeliveryState, alerts: QueueAlert[], now: number) {
  const plan = planAlertDelivery(alerts, state, now)
  let next = plan.state
  for (const a of plan.opened) next = markAnnounced(next, episodeKey(a), now)
  for (const key of plan.recovered) next = markRecovered(next, key)
  return { plan, state: next }
}

describe('planAlertDelivery', () => {
  it('всё хорошо и раньше было хорошо — молчим', () => {
    const p = planAlertDelivery([], emptyDeliveryState(), T)
    expect(p.opened).toEqual([])
    expect(p.recovered).toEqual([])
  })

  it('новая проблема — объявляем', () => {
    const { plan } = tick(emptyDeliveryState(), [stalled()], T)
    expect(plan.opened.map(a => a.queue)).toEqual(['crm-sync'])
  })

  // Проверка идёт каждые 5 минут, а настоящая поломка живёт дольше. Без этого одна сломанная
  // очередь давала бы двенадцать одинаковых сообщений в час, и канал перестали бы читать.
  it('та же проблема на следующих замерах — второй раз не пишем', () => {
    let s = tick(emptyDeliveryState(), [stalled()], T).state
    for (let i = 1; i <= 10; i++) {
      const r = tick(s, [stalled()], T + i * 300_000)
      expect(r.plan.opened).toEqual([])
      expect(r.plan.recovered).toEqual([])
      s = r.state
    }
  })

  // Без этого читатель не отличит «починилось само» от «всё ещё лежит, просто мы замолчали».
  it('проблема ушла — сообщаем о восстановлении, и ровно один раз', () => {
    const a = tick(emptyDeliveryState(), [stalled()], T)
    const b = tick(a.state, [], T + 300_000)
    expect(b.plan.recovered).toEqual(['stalled:crm-sync'])
    const c = tick(b.state, [], T + 600_000)
    expect(c.plan.recovered).toEqual([])
  })

  // Самый неприятный случай: поломка стоит ровно на пороге и срабатывает через замер. Без запрета
  // это 24 сообщения в час — строго хуже той аварии, о которой они сообщают.
  it('мерцание вокруг порога не превращается в поток сообщений', () => {
    let s: DeliveryState = emptyDeliveryState()
    let messages = 0
    for (let i = 0; i < 12; i++) { // час замеров, поломка через раз
      const r = tick(s, i % 2 === 0 ? [failing()] : [], T + i * 300_000)
      messages += r.plan.opened.length + r.plan.recovered.length
      s = r.state
    }
    // Ровно одно «сломалось» и одно «починилось» за час, а не по паре на каждый замер.
    expect(messages).toBe(2)
  })

  it('через час после затишья новая поломка объявляется снова', () => {
    const a = tick(emptyDeliveryState(), [stalled()], T)
    const b = tick(a.state, [], T + 300_000)
    const c = tick(b.state, [stalled()], T + MIN_REANNOUNCE_MS + 300_000)
    expect(c.plan.opened.map(episodeKey)).toEqual(['stalled:crm-sync'])
  })

  // Раньше эпизод помечался объявленным ДО отправки: один отказ Телеграма — и тревога не звучала
  // больше никогда, потому что со следующего замера она «уже идущая».
  it('неудачная отправка — повторяем на следующем замере, а не теряем', () => {
    const first = planAlertDelivery([stalled()], emptyDeliveryState(), T)
    expect(first.opened).toHaveLength(1)
    // Отправка не удалась → markAnnounced НЕ вызываем.
    const second = planAlertDelivery([stalled()], first.state, T + 300_000)
    expect(second.opened.map(episodeKey)).toEqual(['stalled:crm-sync'])
  })

  it('о восстановлении не сообщаем, если о поломке так и не сказали', () => {
    // Поломка была, но отправить не удалось; затем она ушла.
    const first = planAlertDelivery([stalled()], emptyDeliveryState(), T)
    const second = planAlertDelivery([], first.state, T + 300_000)
    expect(second.recovered).toEqual([])
  })

  it('разные виды поломки в одной очереди — разные сообщения', () => {
    const { plan } = tick(emptyDeliveryState(), [stalled('crm-sync'), failing('crm-sync')], T)
    expect(plan.opened).toHaveLength(2)
  })

  it('одна очередь починилась, другая сломалась — обе новости за один замер', () => {
    const a = tick(emptyDeliveryState(), [stalled('crm-sync')], T)
    const b = tick(a.state, [stalled('file-extract')], T + 300_000)
    expect(b.plan.opened.map(x => x.queue)).toEqual(['file-extract'])
    expect(b.plan.recovered).toEqual(['stalled:crm-sync'])
  })

  // Иначе карта отметок росла бы всё время работы процесса.
  it('старые отметки вычищаются, когда перестают работать', () => {
    const a = tick(emptyDeliveryState(), [stalled()], T)
    const b = tick(a.state, [], T + 300_000)
    expect(Object.keys(b.state.announcedAtMs)).toEqual(['stalled:crm-sync'])
    const c = tick(b.state, [], T + MIN_REANNOUNCE_MS + 300_000)
    expect(Object.keys(c.state.announcedAtMs)).toEqual([])
    expect(c.state.awaitingRecovery).toEqual([])
  })
})

describe('тексты сообщений', () => {
  it('в тревоге видно, что случилось, и куда посмотреть', () => {
    const m = alertMessage(stalled(), 'https://app.example/queues')
    expect(m).toContain('не разгребается')
    expect(m).toContain('https://app.example/queues')
  })

  it('без известного адреса — просто без ссылки, не «undefined»', () => {
    const m = alertMessage(stalled(), null)
    expect(m).not.toContain('undefined')
    expect(m).not.toContain('null')
  })

  it('в восстановлении названы и очередь, и что именно прекратилось', () => {
    expect(recoveryMessage('stalled:crm-sync')).toContain('crm-sync')
    expect(recoveryMessage('stalled:crm-sync')).toContain('простой')
    expect(recoveryMessage('failing:file-extract')).toContain('падения задач')
  })

  it('незнакомый вид не превращается в «undefined»', () => {
    expect(recoveryMessage('weird:q')).not.toContain('undefined')
  })
})

describe('resolveTelegramConfig', () => {
  const good = { TELEGRAM_ALERT_BOT_TOKEN: '123456789:AAFhq7hSK9d-lPq2mN4vX8zR1tYuIoPaSdF', TELEGRAM_ALERT_CHAT_ID: '-1001234567890' }

  it('оба значения заданы — канал включён', () => {
    expect(resolveTelegramConfig(good)).toEqual({ token: good.TELEGRAM_ALERT_BOT_TOKEN, chatId: '-1001234567890' })
  })

  it('ничего не задано — канал выключен, и это нормальный режим', () => {
    expect(resolveTelegramConfig({})).toBeNull()
  })

  // Настроено наполовину — самый опасный случай: выглядит включённым и молча теряет тревоги.
  it('только токен или только чат — выключено, а не «наполовину»', () => {
    expect(resolveTelegramConfig({ TELEGRAM_ALERT_BOT_TOKEN: good.TELEGRAM_ALERT_BOT_TOKEN })).toBeNull()
    expect(resolveTelegramConfig({ TELEGRAM_ALERT_CHAT_ID: '-100123' })).toBeNull()
  })

  it('обрезанный при вставке токен не принимается', () => {
    expect(resolveTelegramConfig({ ...good, TELEGRAM_ALERT_BOT_TOKEN: '123456789:AAF' })).toBeNull()
  })

  it('чат может быть группой, личным диалогом или @именем', () => {
    for (const chat of ['-1001234567890', '482913', '@my_alerts_channel']) {
      expect(resolveTelegramConfig({ ...good, TELEGRAM_ALERT_CHAT_ID: chat })).not.toBeNull()
    }
  })

  it('мусор в чате не принимается', () => {
    for (const chat of ['not a chat', 'https://t.me/x', '']) {
      expect(resolveTelegramConfig({ ...good, TELEGRAM_ALERT_CHAT_ID: chat })).toBeNull()
    }
  })

  it('пробелы по краям срезаются — их легко привезти из копипаста', () => {
    expect(resolveTelegramConfig({
      TELEGRAM_ALERT_BOT_TOKEN: `  ${good.TELEGRAM_ALERT_BOT_TOKEN}  `,
      TELEGRAM_ALERT_CHAT_ID: ' -100123 '
    })).not.toBeNull()
  })
})

describe('sendTelegramAlert', () => {
  const cfg: TelegramConfig = { token: '123:abc', chatId: '-100' }
  const okRes = { status: 200, json: async () => ({ ok: true }) }

  it('шлёт текст в заданный чат', async () => {
    let seenUrl = ''
    let seenBody: Record<string, unknown> = {}
    await sendTelegramAlert(cfg, 'привет', async (url, init) => {
      seenUrl = String(url)
      seenBody = JSON.parse(String((init as { body?: unknown })?.body))
      return okRes as never
    })
    expect(seenUrl).toContain('/sendMessage')
    expect(seenBody.chat_id).toBe('-100')
    expect(seenBody.text).toBe('привет')
  })

  // parse_mode не задаём: у обычного текста нет разметки, из которой можно вырваться. Гарантия
  // ничего не стоит и переживёт того, кто однажды подставит сюда внешнюю строку.
  it('разметка не включена', async () => {
    let seenBody: Record<string, unknown> = {}
    await sendTelegramAlert(cfg, 'x', async (_u, init) => {
      seenBody = JSON.parse(String((init as { body?: unknown })?.body))
      return okRes as never
    })
    expect(seenBody.parse_mode).toBeUndefined()
  })

  it('слишком длинный текст обрезается — иначе Телеграм отвергнет сообщение целиком', async () => {
    let seenBody: Record<string, unknown> = {}
    await sendTelegramAlert(cfg, 'я'.repeat(MAX_TELEGRAM_TEXT + 500), async (_u, init) => {
      seenBody = JSON.parse(String((init as { body?: unknown })?.body))
      return okRes as never
    })
    expect(String(seenBody.text)).toHaveLength(MAX_TELEGRAM_TEXT)
  })

  // Без таймаута вызов наследует 300-секундный дефолт undici, а зависший исходящий HTTP как раз
  // коррелирует с той аварией, о которой сообщаем.
  it('у отправки есть свой таймаут', async () => {
    let seenSignal: unknown
    await sendTelegramAlert(cfg, 'x', async (_u, init) => {
      seenSignal = (init as { signal?: unknown })?.signal
      return okRes as never
    })
    expect(seenSignal).toBeInstanceOf(AbortSignal)
    expect(TELEGRAM_TIMEOUT_MS).toBeLessThanOrEqual(30_000)
  })

  it('обрыв сети — не падаем и помечаем как повторяемое', async () => {
    const boom = async () => {
      throw new Error('ECONNRESET')
    }
    const r = await sendTelegramAlert(cfg, 'x', boom)
    expect(r).toEqual({ ok: false, status: 0, retryable: true })
  })

  it('неверный токен повторять бессмысленно, перегрузку — есть смысл', async () => {
    const at = async (status: number) =>
      sendTelegramAlert(cfg, 'x', async () => ({ status } as never))
    expect((await at(401)).retryable).toBe(false)
    expect((await at(400)).retryable).toBe(false)
    expect((await at(429)).retryable).toBe(true)
    expect((await at(502)).retryable).toBe(true)
  })
})

// Живой прогон 2026-08-02: Redis остановили — пришло четыре тревоги подряд, по одной на очередь.
// Тот же счёт получило бы и «восстановилось» на подъёме. Схлопывание сделано в `evaluateQueueHealth`
// (одна авария — один эпизод), а здесь проверяется, что доставка это видит именно так.
describe('#алертинг: авария конвейера — один эпизод от поломки до восстановления', () => {
  const down = (...names: string[]) => ['b24-events', 'file-extract', 'agent-run', 'crm-sync']
    .map(queue => ({ queue, unreadable: names.includes(queue), oldestPendingAgeMs: null, pending: 0, recentFailures: 0 }))
  const ALL = ['b24-events', 'file-extract', 'agent-run', 'crm-sync']

  it('поломка объявляется ОДИН раз, восстановление — тоже один', () => {
    const first = planAlertDelivery(evaluateQueueHealth(down(...ALL), 0), emptyDeliveryState(), 0)
    expect(first.opened).toHaveLength(1)

    let state = markAnnounced(first.state, episodeKey(first.opened[0]!), 0)
    const second = planAlertDelivery(evaluateQueueHealth(down(...ALL), 5 * 60_000), state, 5 * 60_000)
    expect(second.opened).toEqual([])

    state = second.state
    const up = planAlertDelivery(evaluateQueueHealth(down(), 10 * 60_000), state, 10 * 60_000)
    expect(up.recovered).toHaveLength(1)
    expect(recoveryMessage(up.recovered[0]!)).toContain('очереди снова читаются')
  })

  it('полная → частичная → полная: ни одной ложной галочки, тревога не глохнет', () => {
    // Главная находка разбора. Пока ключ зависел от формы аварии, на третьем шаге канал слал
    // «✅ восстановилось» при мёртвом конвейере, а настоящая тревога тонула в окне повтора.
    let state = emptyDeliveryState()
    const p1 = planAlertDelivery(evaluateQueueHealth(down(...ALL), 0), state, 0)
    expect(p1.opened).toHaveLength(1)
    state = markAnnounced(p1.state, episodeKey(p1.opened[0]!), 0)

    const p2 = planAlertDelivery(evaluateQueueHealth(down('crm-sync'), 5 * 60_000), state, 5 * 60_000)
    expect(p2.recovered).toEqual([]) // авария не кончилась, лишь сузилась
    state = p2.state

    const p3 = planAlertDelivery(evaluateQueueHealth(down(...ALL), 10 * 60_000), state, 10 * 60_000)
    expect(p3.recovered).toEqual([])
    state = p3.state

    // И только когда всё прочиталось — ровно одно «восстановилось».
    const p4 = planAlertDelivery(evaluateQueueHealth(down(), 15 * 60_000), state, 15 * 60_000)
    expect(p4.recovered).toHaveLength(1)
  })

  it('на нечитаемом конвейере простой соседней очереди НЕ объявляется починенным', () => {
    // Разбор: crm-sync встал, при деплое на полминуты перезапустили Redis — и канал прислал
    // «✅ простой закончился», после чего настоящий простой молчал час. Мы ничего не знаем о
    // конвейере, которого не прочитали, и «эпизод пропал из замера» больше не значит «починился».
    const stalled = [{ queue: 'crm-sync', oldestPendingAgeMs: 40 * 60_000, pending: 7, recentFailures: 0 }]
    let state = emptyDeliveryState()
    const p1 = planAlertDelivery(evaluateQueueHealth(stalled, 0), state, 0)
    expect(p1.opened).toHaveLength(1)
    state = markAnnounced(p1.state, episodeKey(p1.opened[0]!), 0)

    const blind = [{ queue: 'crm-sync', unreadable: true, oldestPendingAgeMs: null, pending: 0, recentFailures: 0 }]
    const p2 = planAlertDelivery(evaluateQueueHealth(blind, 5 * 60_000), state, 5 * 60_000)
    expect(p2.recovered).toEqual([])
    // Простой остаётся открытым: вернулась читаемость — заново его не объявляем, он не прерывался.
    const p3 = planAlertDelivery(evaluateQueueHealth(stalled, 10 * 60_000), p2.state, 10 * 60_000)
    expect(p3.opened).toEqual([])
  })

  it('«восстановилось» выбывает из ожидания только по факту доставки', () => {
    // Зеркало markAnnounced. Без этого один отказ Телеграма терял бы ✅ навсегда: оператор видит
    // «сломалось» и не видит закрытия — состояние, неотличимое от продолжающейся аварии.
    let state = emptyDeliveryState()
    const p1 = planAlertDelivery(evaluateQueueHealth(down(...ALL), 0), state, 0)
    state = markAnnounced(p1.state, episodeKey(p1.opened[0]!), 0)

    const p2 = planAlertDelivery(evaluateQueueHealth(down(), 10 * 60_000), state, 10 * 60_000)
    expect(p2.recovered).toHaveLength(1)
    // Отправка не удалась ⇒ markRecovered НЕ зовём — ключ всё ещё ждёт закрытия.
    expect(p2.state.awaitingRecovery).toContain(p2.recovered[0]!)
    const p3 = planAlertDelivery(evaluateQueueHealth(down(), 15 * 60_000), p2.state, 15 * 60_000)
    expect(p3.recovered).toHaveLength(1)
    // Доставили — больше не повторяем.
    const after = markRecovered(p3.state, p3.recovered[0]!)
    expect(planAlertDelivery(evaluateQueueHealth(down(), 20 * 60_000), after, 20 * 60_000).recovered).toEqual([])
  })

  it('текст восстановления согласован по-русски и не печатает служебное имя', () => {
    // Было «очереди снова читаются — нечитаемая очередь прекратились»: и число не согласовано, и
    // очередь не может «прекратиться» — прекращается состояние. В три часа ночи это читается как
    // сломанный шаблон, то есть ровно как то, чего канал должен избегать сильнее всего.
    const all = recoveryMessage(`unreadable:${ALL_QUEUES}`)
    expect(all).toBe('✅ AI-импорт прайсов: очереди снова читаются.')
    expect(all).not.toContain('«*»')
    expect(recoveryMessage('stalled:crm-sync')).toBe('✅ AI-импорт прайсов: очередь «crm-sync» — простой закончился.')
    expect(recoveryMessage('failing:crm-sync')).toBe('✅ AI-импорт прайсов: очередь «crm-sync» — падения задач прекратились.')
  })
})
