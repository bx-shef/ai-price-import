import { describe, expect, it } from 'vitest'
import { createJob } from '../server/utils/jobStore'
import { jobRedis } from '../server/utils/jobStoreRedis'
import { liveCrmSyncDeps } from '../server/queue/liveDeps'
import type { LiveInfra } from '../server/queue/liveDeps'
import { defaultMapping } from '~/utils/portalSettings'
import type { PortalMapping } from '~/types/settings'

// #385, проводка сообщения в чат ошибок.
//
// Чистая `buildErrorMessage` покрыта отдельно, и этого НЕ ХВАТАЕТ: разбор прогнал по проводке
// мутацию «поменять местами `jobId` и `appUrl` в вызове» — весь набор тестов остался зелёным. В
// чат при этом ушло бы `Задание: https://…` и `[URL=job-7]открыть приложение[/URL]`, то есть
// ссылка перестала бы быть ссылкой, а номер задания — читаемым идентификатором: ровно тот симптом,
// ради устранения которого правка и делалась, только уровнем выше, где теста не было.
//
// Поэтому тест смотрит на то, ЧТО РЕАЛЬНО УШЛО в чат, а не на то, что функция вызвана.

interface Sent { method: string, params: Record<string, unknown> }

const DOMAIN = 'b24-hrbvzq.bitrix24.by'
const APP_URL = `https://${DOMAIN}/marketplace/view/shef.priceimport/`

function harness(opts: { domain?: string | null } = {}) {
  const sent: Sent[] = []
  let tokenReads = 0
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    sent.push({ method, params })
    // Бота нет — отправка идёт старым путём (`im.message.add`), как на портале без скоупа `imbot`.
    if (method.startsWith('imbot.')) throw new Error('ACCESS_DENIED')
    return {} as never
  }
  const query = async (sql: string) => {
    if (/FROM portal_tokens/i.test(sql) && /SELECT \*/i.test(sql)) {
      tokenReads++
      if (opts.domain === null) return { rows: [] }
      return { rows: [{ member_id: 'm1', domain: opts.domain ?? DOMAIN, access_token: 'a', refresh_token: 'r', expires_at: 0 }] }
    }
    return { rows: [] }
  }
  const infra = { query } as unknown as LiveInfra
  const rest = async () => ({ call, list: async () => [] } as never)
  return { sent, infra, rest, tokenReads: () => tokenReads }
}

// Настоящие дефолты портала, а не самодельный объект: подделка молча разошлась бы с боевой формой
// (первая редакция теста так и падала — у неё не было блока единиц измерения).
const mapping = (over: Partial<PortalMapping> = {}): PortalMapping =>
  ({ ...defaultMapping(), errorChatId: 'chat42', notifyChatId: null, ...over })

const chatMessages = (sent: Sent[], dialogId: string) =>
  sent.filter(s => s.method === 'im.message.add' && s.params.DIALOG_ID === dialogId)
    .map(s => String(s.params.MESSAGE ?? ''))

describe('#385: сообщение в чат ошибок доезжает собранным', () => {
  it('несёт НОМЕР задания и ссылку в ПОРТАЛ, каждое на своём месте', async () => {
    const h = harness()
    await createJob('m1', 'job-7', 'накладная.pdf', jobRedis, null, '7')
    const deps = liveCrmSyncDeps('m1', 'job-7', mapping(), h.rest, h.infra)
    await deps.reportErrors?.(['валюта XXX отсутствует'], 'ООО Ромашка')

    const [msg] = chatMessages(h.sent, 'chat42')
    expect(msg, 'сообщение в чат ошибок не ушло').toBeDefined()
    expect(msg).toContain('Задание: job-7')
    expect(msg).toContain(`[URL=${APP_URL}]открыть приложение[/URL]`)
    // Перестановка аргументов даёт `Задание: https://…` — утверждаем и обратное тоже.
    expect(msg).not.toContain('Задание: https://')
    expect(msg).not.toContain('[URL=job-7]')
  })

  it('домен портала неизвестен ⇒ текст без ссылки, но с номером задания', async () => {
    // Мёртвая ссылка обещает путь и никуда не ведёт; номер задания при этом остаётся единственным,
    // по чему администратор может найти отказ — серверного списка заданий нет.
    const h = harness({ domain: null })
    await createJob('m1', 'job-8', 'счёт.pdf', jobRedis, null, '7')
    const deps = liveCrmSyncDeps('m1', 'job-8', mapping(), h.rest, h.infra)
    await deps.reportErrors?.(['нет ставки НДС'], 'ООО Ромашка')

    const [msg] = chatMessages(h.sent, 'chat42')
    expect(msg).toContain('Задание: job-8')
    expect(msg).not.toContain('[URL=')
  })

  it('адрес приложения читается ОДИН раз на отказ, а не на каждого получателя', async () => {
    // Один отказ = два получателя (личное сообщение сотруднику и чат ошибок), и обоим нужен один и
    // тот же адрес. Без мемоизации правка добавляла второй SELECT строки портала, узнающий ровно то
    // же самое. Считаем чтения `portal_tokens` напрямую — иначе регрессия невидима.
    const h = harness()
    await createJob('m1', 'job-9', 'акт.pdf', jobRedis, null, '7')
    const deps = liveCrmSyncDeps('m1', 'job-9', mapping(), h.rest, h.infra)
    await deps.reportErrors?.(['ошибка'], 'ООО Ромашка')

    expect(h.tokenReads()).toBe(1)
  })
})
