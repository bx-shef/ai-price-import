import { describe, expect, it } from 'vitest'
import { createJob } from '../server/utils/jobStore'
import { jobRedis } from '../server/utils/jobStoreRedis'
import { notifyImportFailure } from '../server/queue/liveDeps'
import type { LiveInfra } from '../server/queue/liveDeps'

// #385, второй заход. Разбор нашёл ДВЕ вещи, которых юнит-тесты чистых функций увидеть не могли,
// потому что обе живут в проводке:
//
//   1. чтение строки портала ради домена стоит ПОСЛЕ once-only заявки на отправку и внутри пустого
//      `catch` — блип Postgres ровно в этот момент означал, что сотрудник НИКОГДА не узнает о
//      неудаче: сообщение не ушло, право говорить сожжено, повтор молчит;
//   2. мутация «нет домена ⇒ вернуть ссылку на наш хост» проходила при зелёных тестах.
//
// Отсюда тест поведенческий, а не текстовый: он зовёт настоящую `notifyImportFailure` с фальшивым
// транспортом и фальшивым запросом к БД и смотрит, что РЕАЛЬНО ушло в чат.

interface Sent { method: string, params: Record<string, unknown> }

function harness(opts: { queryThrows?: boolean, domain?: string, appInfoFails?: boolean } = {}) {
  const sent: Sent[] = []
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    sent.push({ method, params })
    // Бота нет — отправка идёт старым путём (`im.message.add`), как на портале без скоупа `imbot`.
    if (method.startsWith('imbot.')) throw new Error('ACCESS_DENIED')
    // ⚠ Адрес приложения теперь ЧИСЛОВОЙ (`/marketplace/app/<ID>/`, #385 второй заход): символьный
    // код карточки Маркета на портале не открывается. `ID` приходит из `app.info`, и портал,
    // который на него не отвечает, законно оставляет сообщение без ссылки — это отдельная ветка.
    if (method === 'app.info') return (opts.appInfoFails ? null : { ID: 3 }) as never
    return {} as never
  }
  const query = async (sql: string) => {
    if (/FROM portal_tokens/i.test(sql) && /SELECT \*/i.test(sql)) {
      if (opts.queryThrows) throw new Error('db is down')
      return { rows: [{ member_id: 'm1', domain: opts.domain ?? 'x.bitrix24.by', access_token: 'a', refresh_token: 'r', expires_at: 0 }] }
    }
    return { rows: [] }
  }
  const infra = { query } as unknown as LiveInfra
  const rest = async () => ({ call, list: async () => [] } as never)
  return { sent, infra, rest }
}

const messages = (sent: Sent[]) => sent.filter(s => s.method === 'im.message.add').map(s => String(s.params.MESSAGE ?? ''))

describe('#385: проводка ссылки не может съесть само уведомление', () => {
  it('падение БД при чтении домена НЕ отменяет сообщение — уходит текст без ссылки', async () => {
    // Измеренная регрессия: без гарда здесь уходило НОЛЬ сообщений, а повтор той же задачи молчал,
    // потому что once-only заявка уже израсходована.
    const h = harness({ queryThrows: true })
    await createJob('m1', 'j-db-down', 'счёт.pdf', jobRedis, null, '7')
    await notifyImportFailure(h.infra, 'm1', 'j-db-down', 'не удалось прочитать документ', { rest: h.rest, alsoErrorChat: false })

    const msgs = messages(h.sent)
    expect(msgs.length, 'сообщение потеряно').toBe(1)
    expect(msgs[0]).toContain('счёт.pdf')
    expect(msgs[0]).toContain('Файл можно загрузить снова в приложении.')
    expect(msgs[0]).not.toContain('[URL=')
  })

  it('домен известен — ссылка ведёт в ПОРТАЛ', async () => {
    const h = harness({ domain: 'b24-hrbvzq.bitrix24.by' })
    await createJob('m1', 'j-ok', 'накладная.pdf', jobRedis, null, '7')
    await notifyImportFailure(h.infra, 'm1', 'j-ok', 'документ не распознан', { rest: h.rest, alsoErrorChat: false })

    const msgs = messages(h.sent)
    expect(msgs.length).toBe(1)
    expect(msgs[0]).toContain('[URL=https://b24-hrbvzq.bitrix24.by/marketplace/app/3/]')
    // Символьная форма сюда вернуться не должна: она на портале не открывается (#385, живой прогон).
    expect(msgs[0]).not.toContain('/marketplace/view/')
  })

  it('портал не отвечает про приложение — уведомление уходит БЕЗ ссылки, а не пропадает', async () => {
    // ⚠ Адрес стоит REST-вызова (`app.info`), и это новый способ потерять сообщение: метод отвечает
    // только в контексте приложения, у него свои отказы. Отказ ссылки не вправе глушить сам отказ
    // импорта — тот же инвариант, что и у падения базы выше, только по другой причине.
    const h = harness({ domain: 'b24-hrbvzq.bitrix24.by', appInfoFails: true })
    await createJob('m1', 'j-no-appinfo', 'счёт.pdf', jobRedis, null, '7')
    await notifyImportFailure(h.infra, 'm1', 'j-no-appinfo', 'документ не распознан', { rest: h.rest, alsoErrorChat: false })

    const msgs = messages(h.sent)
    expect(msgs.length, 'сообщение потеряно').toBe(1)
    expect(msgs[0]).toContain('Файл можно загрузить снова в приложении.')
    expect(msgs[0]).not.toContain('[URL=')
  })

  it('подменённый домен → ссылки нет, а не ссылка на чужой хост', async () => {
    // Ровно то, что видно человеку: подпись фиксированная, хост в тексте не показан.
    const h = harness({ domain: 'x.bitrix24.by@evil.com' })
    await createJob('m1', 'j-evil', 'счёт.pdf', jobRedis, null, '7')
    await notifyImportFailure(h.infra, 'm1', 'j-evil', 'ошибка', { rest: h.rest, alsoErrorChat: false })

    const msgs = messages(h.sent)
    expect(msgs.length).toBe(1)
    expect(msgs[0]).not.toContain('evil.com')
    expect(msgs[0]).not.toContain('[URL=')
  })

  it('без загрузившего строка портала не читается вовсе', async () => {
    // Ссылку несёт только личное сообщение; чтение ради второй ветки было запросом на каждое
    // уведомление, который никто не потреблял.
    const reads: string[] = []
    const h = harness()
    const infra = {
      query: async (sql: string) => {
        reads.push(sql)
        return { rows: [] }
      }
    } as unknown as LiveInfra
    await createJob('m1', 'j-noup', 'счёт.pdf', jobRedis)
    await notifyImportFailure(infra, 'm1', 'j-noup', 'ошибка', { rest: h.rest, alsoErrorChat: false })
    expect(reads.filter(s => /SELECT \* FROM portal_tokens/i.test(s))).toEqual([])
  })
})
