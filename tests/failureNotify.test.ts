import { describe, expect, it } from 'vitest'
import {
  APP_NAME,
  MAX_CHAT_FILE_NAME,
  MAX_CHAT_REASON,
  chatSafeText,
  humaniseFailureReason,
  planFailureNotify
} from '../server/utils/failureNotify'

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

  it('чат в тихом периоде — сотрудник всё равно узнаёт', () => {
    expect(planFailureNotify({ ...base, errorChatThrottled: true }).map(m => m.dialogId)).toEqual(['42'])
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
