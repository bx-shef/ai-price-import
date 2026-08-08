import { describe, expect, it, vi } from 'vitest'
import { STALE_DAYS, buildDigestText, feedbackIssuesUrl, isoWeekKey, summarizeFeedbackIssues } from '../server/utils/feedbackDigest'
import { DIGEST_COUNTER_TTL_SEC, MAX_ATTEMPTS_PER_WEEK, createDigestRunner } from '../server/utils/feedbackDigestRun'
import { readFileSync } from 'node:fs'
import { listOpenFeedbackIssues } from '../server/utils/feedbackGithubAdmin'
import { resolveTelegramConfig } from '../server/utils/telegramAlert'
import type { FeedbackIssueRef } from '../server/utils/feedbackRetention'

const NOW = Date.parse('2026-08-08T12:00:00Z')
const daysAgo = (n: number) => new Date(NOW - n * 24 * 3600 * 1000).toISOString()
const OPTS = { weekKey: '2026-W32' }

const issue = (over: Partial<FeedbackIssueRef> = {}): FeedbackIssueRef => ({
  number: 1,
  nodeId: 'n1',
  createdAt: daysAgo(1),
  title: '[🔴] Отзыв сотрудника',
  body: 'текст\n\n**Контекст:**\n- **jobId:** `x`',
  labels: ['user-feedback', 'feedback:down'],
  ...over
})

describe('свод открытых отзывов', () => {
  it('считает оценки по МЕТКАМ, а не по заголовку', () => {
    const s = summarizeFeedbackIssues([
      issue({ labels: ['user-feedback', 'feedback:up'], title: 'что угодно' }),
      issue({ labels: ['user-feedback', 'feedback:down'], title: 'что угодно' })
    ], NOW)
    expect(s.up).toBe(1)
    expect(s.down).toBe(1)
    expect(s.open).toBe(2)
  })

  it('задача без нашей оценки считается открытой, но стороны ей не выдумывают', () => {
    const s = summarizeFeedbackIssues([issue({ labels: ['user-feedback'] })], NOW)
    expect(s.open).toBe(1)
    expect(s.up + s.down).toBe(0)
  })

  it('документ считается ТОЛЬКО в секции «Контекст» — комментарий счётчик не накручивает', () => {
    // Комментарий сотрудника экранируется по HTML, но звёздочки в нём живы и стоят ВЫШЕ секции
    // контекста. Тот же класс обхода уже ловили в чистке отзывов.
    const s = summarizeFeedbackIssues([
      issue({ body: 'комментарий\n\n**Контекст:**\n- **Исходный файл:** `ссылка`' }),
      issue({ body: '**Исходный файл:** это я написал руками\n\n**Контекст:**\n- **jobId:** `x`' }),
      issue({ body: 'без файла\n\n**Контекст:**\n- **jobId:** `x`' })
    ], NOW)
    expect(s.withFile).toBe(1)
  })

  it('запущенные, приток и возраст самого старого', () => {
    const s = summarizeFeedbackIssues([
      issue({ createdAt: daysAgo(40) }),
      issue({ createdAt: daysAgo(STALE_DAYS) }),
      issue({ createdAt: daysAgo(2) })
    ], NOW)
    expect(s.stale).toBe(2)
    expect(s.oldestDays).toBe(40)
    expect(s.lastWeek).toBe(1)
  })

  it('граница «за 7 дней» — включительно шесть, исключительно семь', () => {
    const s = summarizeFeedbackIssues([
      issue({ createdAt: daysAgo(6) }),
      issue({ createdAt: daysAgo(7) }),
      issue({ createdAt: daysAgo(8) })
    ], NOW)
    expect(s.lastWeek).toBe(1)
  })

  it('возраст считается ВНИЗ, а не округляется: 13 суток 20 часов — ещё не запущенный', () => {
    // Живой `created_at` приходит со временем суток; при округлении вверх отзыв возрастом 13,8
    // суток объявлялся бы «лежит дольше 14 дней».
    const s = summarizeFeedbackIssues([
      issue({ createdAt: new Date(NOW - (13 * 24 + 20) * 3600 * 1000).toISOString() })
    ], NOW)
    expect(s.oldestDays).toBe(13)
    expect(s.stale).toBe(0)
  })

  it('непрочитанная дата не старит и не омолаживает', () => {
    const s = summarizeFeedbackIssues([issue({ createdAt: 'мусор' })], NOW)
    expect(s.open).toBe(1)
    expect(s.stale).toBe(0)
    expect(s.oldestDays).toBeNull()
  })

  it('расхождение часов не даёт отрицательного возраста', () => {
    const s = summarizeFeedbackIssues([issue({ createdAt: new Date(NOW + 3600_000).toISOString() })], NOW)
    expect(s.oldestDays).toBe(0)
  })
})

describe('текст сводки', () => {
  it('«приёмник не прочитан» — ОТДЕЛЬНЫЙ текст, а не нули, и со СЛЕДУЮЩИМ шагом', () => {
    const t = buildDigestText(null, OPTS)
    expect(t).toMatch(/не прочитан/)
    expect(t).toMatch(/НЕ значит, что отзывов нет/)
    expect(t).toMatch(/GITHUB_FEEDBACK_TOKEN/)
  })

  it('пусто — так и сказано, и неделя названа', () => {
    const t = buildDigestText(summarizeFeedbackIssues([], NOW), OPTS)
    expect(t).toMatch(/неразобранных нет/)
    expect(t).toContain('2026-W32')
  })

  it('каждый счётчик напечатан своей строкой', () => {
    const t = buildDigestText(summarizeFeedbackIssues([
      issue({ createdAt: daysAgo(30), body: '**Контекст:**\n- **Исходный файл:** `x`' }),
      issue({ labels: ['user-feedback', 'feedback:up'] })
    ], NOW), OPTS)
    expect(t).toMatch(/👎 1/)
    expect(t).toMatch(/👍 1/)
    expect(t).toMatch(/С документом \(можно воспроизвести\): 1/)
    expect(t).toMatch(/Из них новых за 7 дней: 1/)
    expect(t).toMatch(/Самый старый ждёт 30 дней/)
    expect(t).toMatch(/1 ждёт дольше 14 дней — разберите их первыми/)
  })

  it('отзыв без метки оценки объявлен «без оценки» — иначе сумма не сходится с числом отзывов', () => {
    const t = buildDigestText(summarizeFeedbackIssues([issue({ labels: ['user-feedback'] })], NOW), OPTS)
    expect(t).toMatch(/без оценки: 1/)
  })

  it('окончания числительных: 1/2/5/21 дня', () => {
    const text = (days: number) => buildDigestText(
      summarizeFeedbackIssues([issue({ createdAt: daysAgo(days) })], NOW), OPTS)
    expect(text(1)).toMatch(/ждёт 1 день/)
    expect(text(2)).toMatch(/ждёт 2 дня/)
    expect(text(5)).toMatch(/ждёт 5 дней/)
    expect(text(21)).toMatch(/ждёт 21 день/)
    // Ноль — не «0 дней», а осмысленная фраза.
    expect(text(0)).toMatch(/пришёл сегодня/)
  })

  it('обрезка объявлена ПЕРВОЙ строкой и говорит, что числа занижены', () => {
    const t = buildDigestText(summarizeFeedbackIssues([issue()], NOW), { ...OPTS, truncated: true })
    expect(t.split('\n')[0]).toMatch(/обрезан.*занижены/)
  })

  it('ссылка на разбор печатается — иначе сводка требует вспоминать, куда идти', () => {
    const t = buildDigestText(summarizeFeedbackIssues([issue()], NOW), { ...OPTS, issuesUrl: feedbackIssuesUrl('o/r') })
    expect(t).toContain('https://github.com/o/r/issues?q=is%3Aopen+label%3Auser-feedback')
  })

  it('свод несёт ТОЛЬКО числа — текстовое поле в него не добавить незаметно', () => {
    // Гард формы, а не содержимого: сегодняшний текст проверен полем за полем, но новое поле
    // `DigestStats` со строкой из тела отзыва прошло бы все проверки выше и уехало в мессенджер.
    const s = summarizeFeedbackIssues([issue()], NOW)
    for (const [k, v] of Object.entries(s)) {
      expect(v === null || typeof v === 'number', `поле ${k} обязано быть числом`).toBe(true)
    }
  })

  it('данных клиента в тексте нет ни при каких полях', () => {
    const t = buildDigestText(summarizeFeedbackIssues([
      issue({ title: 'ООО «Ромашка» накладная', body: 'jobId abc-123, файл scan.pdf, комментарий клиента' })
    ], NOW), { ...OPTS, issuesUrl: feedbackIssuesUrl('o/r') })
    expect(t).not.toMatch(/Ромашка|abc-123|scan\.pdf|комментарий клиента/)
  })
})

describe('прогон сводки', () => {
  const makeDeps = (over: Record<string, unknown> = {}) => {
    const sent: string[] = []
    const deps = {
      listIssues: vi.fn(async () => ({ issues: [issue()], truncated: false })),
      send: vi.fn(async (t: string) => {
        sent.push(t)
        return true
      }),
      claimAttempt: vi.fn(async () => null as number | null),
      now: () => NOW
    }
    Object.assign(deps, over)
    return { deps, sent }
  }

  it('нечитаемый приёмник доезжает СВОИМ текстом, а не нулями', async () => {
    // Несущее утверждение задачи. Греп по исходнику его не держит: мутация
    // `summarizeFeedbackIssues(read?.issues ?? [], now)` оставляет вызов на месте.
    const { deps, sent } = makeDeps({ listIssues: async () => null })
    await createDigestRunner(deps)()
    expect(sent[0]).toMatch(/не прочитан/)
    expect(sent[0]).not.toMatch(/неразобранных нет/)
  })

  it('в одну календарную неделю отправляется один раз, в следующую — снова', async () => {
    let now = NOW
    const { deps, sent } = makeDeps({ now: () => now })
    const run = createDigestRunner(deps)
    await run()
    await run()
    expect(sent).toHaveLength(1)
    now = NOW + 8 * 24 * 3600 * 1000
    await run()
    expect(sent).toHaveLength(2)
  })

  it('соседний экземпляр уже отправил → бюджет выбран, мы молчим', async () => {
    // Успех закрывает неделю durable-способом (выбирает остаток бюджета), поэтому пришедший
    // следом экземпляр видит исчерпание, а не «попытка не первая».
    const { deps, sent } = makeDeps({ claimAttempt: async () => MAX_ATTEMPTS_PER_WEEK + 1 })
    await createDigestRunner(deps)()
    expect(sent).toHaveLength(0)
  })

  it('перезапуск после неудачной доставки НЕ хоронит сводку на неделю', async () => {
    // Контейнер перекатывается по десятку раз в день. Прежняя редакция считала «попытка не
    // первая» признаком «сосед уже отправил», и после выката недоставленная сводка объявлялась
    // чужой — то есть не приходила ВООБЩЕ до конца недели.
    let attempt = 0
    const claimAttempt = async () => ++attempt
    const first = makeDeps({ claimAttempt, send: vi.fn(async () => false) })
    await createDigestRunner(first.deps)()
    // Новый процесс: память чиста, общий счётчик помнит одну неудачную попытку.
    const second = makeDeps({ claimAttempt })
    await createDigestRunner(second.deps)()
    expect(second.sent).toHaveLength(1)
  })

  it('без Redis бюджет попыток тоже действует — иначе почасовой обход приёмника', async () => {
    // `send` возвращает `false` и на отказ навсегда (бота выкинули из чата). Память хранила
    // только успех, поэтому обход приёмника шёл каждый час под токеном издателя.
    const { deps } = makeDeps({ claimAttempt: async () => null, send: vi.fn(async () => false) })
    const run = createDigestRunner(deps)
    for (let i = 0; i < 10; i++) await run()
    expect(deps.listIssues).toHaveBeenCalledTimes(MAX_ATTEMPTS_PER_WEEK)
  })

  it('недоставленная сводка повторяется — но не бесконечно', async () => {
    // Прежняя редакция расходовала неделю ДО доставки, и один отказ Телеграма хоронил сводку на
    // семь суток: ровно тот дефект, что дважды исправляли в соседних каналах.
    let attempt = 0
    const { deps, sent } = makeDeps({
      claimAttempt: async () => ++attempt,
      send: vi.fn(async () => false)
    })
    const run = createDigestRunner(deps)
    for (let i = 0; i < 6; i++) await run()
    expect(sent).toHaveLength(0)
    expect(deps.send).toHaveBeenCalledTimes(MAX_ATTEMPTS_PER_WEEK)
  })

  it('чужие задачи приёмника в счёт не идут', async () => {
    // Признак «наша» тот же, что у чистки: метка И заголовок. Опечатка в слаге приёмника иначе
    // дала бы бодрые числа по чужим задачам, а число здесь и есть всё сообщение.
    const { deps, sent } = makeDeps({
      listIssues: async () => ({ issues: [issue({ title: 'заметка владельца' })], truncated: false })
    })
    await createDigestRunner(deps)()
    expect(sent[0]).toMatch(/неразобранных нет/)
  })
})

describe('чтение открытых отзывов', () => {
  const page = (n: number) => Array.from({ length: n }, (_, i) => ({
    number: i + 1, node_id: `n${i}`, created_at: '2026-08-01T00:00:00Z', title: 't', body: 'b', labels: [{ name: 'user-feedback' }]
  }))
  const cfg = { repo: 'o/r', token: 't' } as never
  const fetchOf = (pages: unknown[][], failAt = -1) => vi.fn(async (url: string) => {
    const p = Number(/[&?]page=(\d+)/.exec(url)?.[1] ?? 1)
    if (p === failAt) return { status: 502, json: async () => null } as never
    return { status: 200, json: async () => pages[p - 1] ?? [] } as never
  })

  it('обходит все страницы', async () => {
    const r = await listOpenFeedbackIssues(cfg, fetchOf([page(100), page(3)]) as never)
    expect(r?.issues).toHaveLength(103)
    expect(r?.truncated).toBe(false)
  })

  it('отказ на ВТОРОЙ странице — «не прочитали», а не половина списка', async () => {
    // Половина списка неотличима от спокойной недели: числа были бы занижены молча.
    expect(await listOpenFeedbackIssues(cfg, fetchOf([page(100), page(100)], 2) as never)).toBeNull()
  })

  it('упор в предел страниц объявляется', async () => {
    const r = await listOpenFeedbackIssues(cfg, fetchOf([page(100), page(100)]) as never, 2)
    expect(r?.truncated).toBe(true)
  })

  it('запросы на слияние и битые строки отбрасываются', async () => {
    const rows = [...page(1), { number: 2, node_id: 'x', created_at: 'z', pull_request: {} }, { number: 0 }]
    const r = await listOpenFeedbackIssues(cfg, fetchOf([rows]) as never)
    expect(r?.issues).toHaveLength(1)
  })
})

describe('чат сводки — СВОЙ, а не чат тревог', () => {
  // Мутация «игнорировать имена и читать TELEGRAM_ALERT_*» проходила весь прогон целиком: решение
  // владельца о разделении каналов откатывалось одной строкой бесшумно.
  const env = { TELEGRAM_ALERT_BOT_TOKEN: '12345:' + 'a'.repeat(25), TELEGRAM_ALERT_CHAT_ID: '-100500', TELEGRAM_DIGEST_BOT_TOKEN: '67890:' + 'b'.repeat(25), TELEGRAM_DIGEST_CHAT_ID: '-100777' }
  const names = { token: 'TELEGRAM_DIGEST_BOT_TOKEN', chatId: 'TELEGRAM_DIGEST_CHAT_ID' }

  it('имена переменных решают, в какой чат уйдёт сообщение', () => {
    expect(resolveTelegramConfig(env, names)?.chatId).toBe('-100777')
    expect(resolveTelegramConfig(env)?.chatId).toBe('-100500')
  })

  it('канал сводки не настроен → null, а не подмена чатом тревог', () => {
    const only = { TELEGRAM_ALERT_BOT_TOKEN: env.TELEGRAM_ALERT_BOT_TOKEN, TELEGRAM_ALERT_CHAT_ID: env.TELEGRAM_ALERT_CHAT_ID }
    expect(resolveTelegramConfig(only, names)).toBeNull()
  })

  it('половина настройки — это не настройка', () => {
    expect(resolveTelegramConfig({ TELEGRAM_DIGEST_BOT_TOKEN: env.TELEGRAM_DIGEST_BOT_TOKEN }, names)).toBeNull()
  })
})

describe('ключ недели', () => {
  it('стабилен внутри недели и меняется на её границе', () => {
    const mon = new Date('2026-08-03T00:00:00Z')
    const sun = new Date('2026-08-09T23:59:00Z')
    const next = new Date('2026-08-10T00:01:00Z')
    expect(isoWeekKey(mon)).toBe(isoWeekKey(sun))
    expect(isoWeekKey(next)).not.toBe(isoWeekKey(mon))
  })

  it('на стыке годов номер недели не сбрасывается посреди недели', () => {
    expect(isoWeekKey(new Date('2026-12-31T00:00:00Z'))).toBe(isoWeekKey(new Date('2027-01-01T00:00:00Z')))
  })
})

describe('закрытие недели переживает перезапуск (общий счётчик)', () => {
  // ⚠ Самый важный тест этой ветки, и его не было: мутация «удалить цикл, выбирающий остаток
  // бюджета после успеха» не роняла НИ ОДНОГО теста, потому что соседний экземпляр подменялся
  // моком «уже исчерпан». Здесь счётчик честный и общий, как Redis у двух процессов.
  const sharedCounter = () => {
    const store = new Map<string, number>()
    return async (key: string) => {
      const n = (store.get(key) ?? 0) + 1
      store.set(key, n)
      return n
    }
  }
  const runner = (claimAttempt: (k: string) => Promise<number>, sent: string[], ok = true) =>
    createDigestRunner({
      listIssues: async () => ({ issues: [issue()], truncated: false }),
      send: async (t) => {
        if (ok) sent.push(t)
        return ok
      },
      claimAttempt,
      now: () => NOW
    })

  it('успешно отправивший экземпляр закрывает неделю для СВЕЖЕГО процесса', async () => {
    const claim = sharedCounter()
    const a: string[] = []
    await runner(claim, a)()
    const b: string[] = []
    await runner(claim, b)()
    expect(a).toHaveLength(1)
    expect(b, 'второй процесс не должен слать повтор за ту же неделю').toHaveLength(0)
  })

  it('после неудачи бюджет НЕ закрыт — свежий процесс досылает', async () => {
    const claim = sharedCounter()
    await runner(claim, [], false)()
    const b: string[] = []
    await runner(claim, b)()
    expect(b).toHaveLength(1)
  })

  it('срок счётчика переживает свою неделю и не задерживается дольше следующей', () => {
    expect(DIGEST_COUNTER_TTL_SEC).toBeGreaterThan(7 * 24 * 3600)
    expect(DIGEST_COUNTER_TTL_SEC).toBeLessThan(14 * 24 * 3600)
  })
})

describe('плагин: гейты, которые снимаются одной строкой', () => {
  // Проводка тонкая и интеграционным тестом не покрывается, но два ранних выхода несущие:
  // без гейта крона каждая реплика воркера пришлёт свою копию сводки, а без fail-closed на
  // канале сводка ушла бы в чат тревог или в никуда.
  const src = readFileSync(new URL('../server/plugins/feedbackDigest.ts', import.meta.url), 'utf8')
    .split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')

  it('только крон-экземпляр', () => {
    expect(src).toMatch(/if \(!queueRuntimeConfig\(\)\.cron\) return/)
  })

  it('канал сводки не настроен → выходим, а не шлём в чат тревог', () => {
    expect(src).toMatch(/TELEGRAM_DIGEST_BOT_TOKEN/)
    expect(src).toMatch(/TELEGRAM_DIGEST_CHAT_ID/)
    expect(src).not.toMatch(/TELEGRAM_ALERT_/)
    expect(src.indexOf('if (!telegram)')).toBeGreaterThan(0)
    expect(src.indexOf('if (!telegram)')).toBeLessThan(src.indexOf('createDigestRunner('))
  })
})
