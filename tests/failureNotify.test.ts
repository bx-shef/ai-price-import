import { describe, expect, it } from 'vitest'
import { APP_NAME, humaniseFailureReason, planFailureNotify } from '../server/utils/failureNotify'
import { MAX_CHAT_FILE_NAME, MAX_CHAT_REASON, chatSafeText } from '../server/utils/chatNotify'

const base = {
  claimed: true,
  uploaderId: '42',
  fileName: 'накладная.pdf',
  reason: 'В портале нет ставки НДС 20%',
  errorChatId: 'chat7',
  alsoErrorChat: true,
  jobId: 'job-1'
}

describe('chatSafeText — внешний текст в чате', () => {
  it('скобочная разметка обезврежена', () => {
    expect(chatSafeText('[URL=http://evil]клик[/URL]', 200)).not.toContain('[URL=')
    expect(chatSafeText('[USER=1]тык[/USER]', 200)).not.toContain('[USER=')
  })

  it('голая ссылка перестаёт быть ссылкой', () => {
    // Имя файла задаёт кто угодно. Без этого «Счёт №77 оплатите тут https://…» приходил
    // администратору В ЧАТ ОТ ИМЕНИ ПРИЛОЖЕНИЯ — доверенный отправитель, кликабельная ссылка.
    const out = chatSafeText('Счёт оплатите тут https://b24-oplata.example.com/inv', 200)
    expect(out).not.toContain('https://')
    expect(out).toContain('b24-oplata.example.com') // читать по-прежнему можно
    expect(chatSafeText('зайдите на www.evil.test', 200)).not.toContain('www.')
  })

  it('переводы строк схлопываются — иначе внешний текст подделывает структуру сообщения', () => {
    // >> в начале строки — цитата, строка из дефисов — разделитель.
    const out = chatSafeText('обычно\n>>цитата\n------\nещё', 200)
    expect(out).not.toContain('\n')
  })

  it('режется по заданной длине', () => {
    expect(chatSafeText('я'.repeat(500), 10)).toHaveLength(10)
  })

  it('пусто на пустом входе, без падений', () => {
    expect(chatSafeText(undefined, 50)).toBe('')
    expect(chatSafeText(null, 50)).toBe('')
  })
})

describe('humaniseFailureReason', () => {
  it('вывод внешних программ не показываем человеку', () => {
    // Там внутренние пути с member_id, идентификатором задания и именем листа Excel.
    const out = humaniseFailureReason('извлечение текста: Command failed: pdftotext /data/uploads/m1/j2.pdf')
    expect(out).not.toContain('pdftotext')
    expect(out).not.toContain('/data/uploads')
    expect(out).toContain('прочитать файл')
  })

  it('наши собственные объяснения проходят как есть', () => {
    const r = 'Не удалось внести документ в «Смарт-счёт» — этот тип недоступен на портале.'
    expect(humaniseFailureReason(r)).toBe(r)
  })

  it('пусто остаётся пустым', () => {
    expect(humaniseFailureReason('')).toBe('')
  })
})

describe('planFailureNotify — кому и что', () => {
  it('не заявлено — не пишем никому', () => {
    expect(planFailureNotify({ ...base, claimed: false })).toEqual([])
  })

  it('сотруднику и в чат ошибок — два адресата', () => {
    const p = planFailureNotify(base)
    expect(p.map(m => m.dialogId)).toEqual(['42', 'chat7'])
  })

  it('сотрудник неизвестен — остаётся только чат ошибок', () => {
    const p = planFailureNotify({ ...base, uploaderId: null })
    expect(p.map(m => m.dialogId)).toEqual(['chat7'])
  })

  it('чат ошибок не настроен — остаётся только личное сообщение', () => {
    expect(planFailureNotify({ ...base, errorChatId: null }).map(m => m.dialogId)).toEqual(['42'])
  })

  it('alsoErrorChat=false — только личное: этот путь пишет в чат сам', () => {
    // Жёсткая ошибка записи в CRM уже отправила своё сообщение; второе читалось бы как второй отказ.
    expect(planFailureNotify({ ...base, alsoErrorChat: false }).map(m => m.dialogId)).toEqual(['42'])
  })

  it('сообщения разные: личное зовёт вернуться, чат даёт по чему искать', () => {
    const [dm, chat] = planFailureNotify(base)
    expect(dm!.message).toContain(APP_NAME) // от кого сообщение — в первой строке
    expect(dm!.message).not.toContain('Задание:')
    expect(chat!.message).toContain('Задание: job-1') // единственная зацепка: списка заданий на сервере нет
    expect(chat!.message).not.toContain(APP_NAME)
  })

  it('в личном есть ссылка на приложение, когда адрес известен', () => {
    const [dm] = planFailureNotify({ ...base, appUrl: 'https://app.example/app' })
    expect(dm!.message).toContain('[URL=https://app.example/app]')
  })

  it('адрес неизвестен — ссылки нет, но что делать сказано', () => {
    const [dm] = planFailureNotify(base)
    expect(dm!.message).not.toContain('[URL=')
    expect(dm!.message).toContain('загрузить снова')
  })

  it('фишинг через имя файла не доезжает ни до кого', () => {
    const p = planFailureNotify({ ...base, fileName: 'Счёт оплатите https://evil.test/pay .pdf' })
    for (const m of p) expect(m.message).not.toContain('https://')
  })

  it('технический текст не доезжает ни до кого', () => {
    const p = planFailureNotify({ ...base, reason: 'извлечение текста: Command failed: /tmp/x/Лист1.csv' })
    for (const m of p) expect(m.message).not.toContain('/tmp/')
  })

  it('длинные имя и причина обрезаны — оба конца ограничены', () => {
    const p = planFailureNotify({
      ...base,
      fileName: 'и'.repeat(500) + '.pdf',
      reason: 'я'.repeat(500)
    })
    for (const m of p) expect(m.message.length).toBeLessThan(MAX_CHAT_FILE_NAME + MAX_CHAT_REASON + 200)
  })

  it('без имени файла сообщение остаётся осмысленным', () => {
    const [dm] = planFailureNotify({ ...base, fileName: '' })
    expect(dm!.message).toContain('«документ»')
  })
})

// Проводка фолбэка — по исходнику (liveDeps — I/O-край, юнитами не гоняется; конвенция —
// tests/importStatusRoute.test.ts). Стережёт откат двух правок: без фолбэка личное сообщение на
// одноадминном портале молча терялось (портал запрещает self-диалог, а клейм одноразовый), без
// warn потерянное сообщение не оставляло следа вообще.
describe('проводка: отказ личного диалога не теряет сообщение', () => {
  it('liveDeps шлёт отвергнутое личное сообщение в центр уведомлений и логирует потерю', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../server/queue/liveDeps.ts', import.meta.url), 'utf8')
    expect(src).toContain('im.notify.system.add')
    expect(src).toContain('console.warn')
    // Фолбэк — только для личного адресата (голый числовой id), чат ошибок им не подменяется.
    expect(src.indexOf('im.notify.system.add')).toBeGreaterThan(src.indexOf('sendChatMessage(m.dialogId'))
  })

  it('уведомление несёт MESSAGE_OUT — во внешний канал уходит текст без BB-разметки', async () => {
    // ⚠ Это НЕ украшение. `MESSAGE` у `im.notify.system.add` BB-коды поддерживает (документация
    // метода), а вот внешним каналам — почте и пушу — портал отдаёт `MESSAGE_OUT`; не задан, и
    // туда уходит тот же `MESSAGE`, то есть человек читает в письме буквальное
    // `[URL=https://…]открыть приложение[/URL]`. Прежде поле не заполнялось вовсе, и весь путь
    // числился «никем не проверенным» — вопрос закрыт документацией, а не догадкой.
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../server/queue/liveDeps.ts', import.meta.url), 'utf8')
    const call = src.slice(src.indexOf('im.notify.system.add'))
    const body = call.slice(0, call.indexOf('})') + 2)
    expect(body, 'MESSAGE_OUT не передаётся — в письмо уйдёт сырая BB-разметка').toContain('MESSAGE_OUT')
    expect(body, 'MESSAGE_OUT собран не тем же текстом').toMatch(/MESSAGE_OUT:\s*bbToPlainText\(m\.message\)/)
  })
})
