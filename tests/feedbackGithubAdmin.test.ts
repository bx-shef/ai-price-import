import { describe, expect, it } from 'vitest'
import { deleteFeedbackFile, deleteIssueComments, isOwnLabel, listFeedbackDir, listOldestFeedbackIssues, redactFeedbackIssue } from '../server/utils/feedbackGithubAdmin'
import type { FeedbackIssueRef } from '../server/utils/feedbackRetention'

// #417. Транспорт чистки не был покрыт ВОВСЕ, и мутационная проверка это показала: трактовки
// «404 в листинге = каталога нет» и «404 при удалении = отказ» описаны в комментариях как
// инварианты, но их можно было поменять местами при зелёном CI — а вторая из них возвращает
// дефект «задача стёрта, документ клиента цел».

const config = { token: 'secret-token', repo: 'owner/receiver' }

type Call = { url: string, method: string, body?: unknown }

/** Фейк `FetchFn`: отвечает по карте «метод + кусок адреса» и записывает вызовы. */
function fakeFetch(routes: Array<[string, { status: number, json?: unknown, throws?: boolean }]>) {
  const calls: Call[] = []
  const fn = (async (url: string, init?: { method?: string, body?: string }) => {
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined })
    const hit = routes.find(([key]) => {
      const [m, part] = key.split(' ')
      return m === method && url.includes(part!)
    })
    if (!hit) throw new Error(`нет заглушки для ${method} ${url}`)
    if (hit[1].throws) throw new Error('network')
    return {
      status: hit[1].status,
      json: async () => hit[1].json
    }
  }) as never
  return { fn, calls }
}

describe('#417: листинг каталога', () => {
  it('200 со списком файлов — пути из ответа GitHub', async () => {
    const { fn } = fakeFetch([['GET /contents/', { status: 200, json: [
      { type: 'file', path: 'files/tag/job/a.pdf' },
      { type: 'file', path: 'files/tag/job/b.xlsx' }
    ] }]])
    expect(await listFeedbackDir(config, 'files/tag/job', fn)).toEqual(['files/tag/job/a.pdf', 'files/tag/job/b.xlsx'])
  })

  it('404 — каталога нет, это НЕ отказ', async () => {
    // Каталог мог быть удалён прошлым прогоном или отзыв пришёл без файла. Трактовка «отказ»
    // залипала бы навсегда на каждой задаче без вложения.
    const { fn } = fakeFetch([['GET /contents/', { status: 404 }]])
    expect(await listFeedbackDir(config, 'files/tag/job', fn)).toEqual([])
  })

  it('прочие коды и сетевой сбой — отказ, а не пустота', async () => {
    // «Нет прав» и «нет каталога» на приватном репозитории выглядят одинаково; принять отказ за
    // пустоту значит стереть задачу и оставить документ.
    for (const status of [401, 403, 500, 502]) {
      const { fn } = fakeFetch([['GET /contents/', { status }]])
      expect(await listFeedbackDir(config, 'files/tag/job', fn), String(status)).toBeNull()
    }
    const { fn } = fakeFetch([['GET /contents/', { status: 200, throws: true }]])
    expect(await listFeedbackDir(config, 'files/tag/job', fn)).toBeNull()
  })

  it('не-файл в каталоге — отказ: мы кладём только плоские файлы', async () => {
    const { fn } = fakeFetch([['GET /contents/', { status: 200, json: [{ type: 'dir', path: 'files/tag/job/sub' }] }]])
    expect(await listFeedbackDir(config, 'files/tag/job', fn)).toBeNull()
  })

  it('чужие пути из ответа не берём', async () => {
    const { fn } = fakeFetch([['GET /contents/', { status: 200, json: [
      { type: 'file', path: 'files/other/job/x.pdf' },
      { type: 'file', path: 'files/tag/job/ok.pdf' }
    ] }]])
    expect(await listFeedbackDir(config, 'files/tag/job', fn)).toEqual(['files/tag/job/ok.pdf'])
  })
})

describe('#417: удаление файла', () => {
  it('читает sha и удаляет', async () => {
    const { fn, calls } = fakeFetch([
      ['GET /contents/', { status: 200, json: { sha: 'abc123' } }],
      ['DELETE /contents/', { status: 200 }]
    ])
    expect(await deleteFeedbackFile(config, 'files/t/j/a.pdf', fn)).toBe(true)
    expect((calls[1]!.body as { sha: string }).sha).toBe('abc123')
  })

  it('404 — ОТКАЗ, а не успех', async () => {
    // Путь только что пришёл из листинга того же каталога: файл существовал. 404 означает
    // нехватку прав, и принять его за успех значит стереть задачу при живом документе.
    const { fn } = fakeFetch([['GET /contents/', { status: 404 }]])
    expect(await deleteFeedbackFile(config, 'files/t/j/a.pdf', fn)).toBe(false)
  })

  it('нет sha в ответе — отказ', async () => {
    const { fn } = fakeFetch([['GET /contents/', { status: 200, json: {} }]])
    expect(await deleteFeedbackFile(config, 'files/t/j/a.pdf', fn)).toBe(false)
  })
})

describe('#417: деградация вместо удаления', () => {
  const issue: FeedbackIssueRef = {
    number: 7,
    nodeId: 'n7',
    createdAt: '2024-01-01T00:00:00Z',
    title: '[🔴] Отзыв сотрудника',
    body: 'тело',
    labels: ['user-feedback', 'feedback:down', 'portal:a1b2c3d4e5f6', 'триаж:разобрано', 'bug']
  }

  it('снимает ТОЛЬКО наши метки', () => {
    for (const own of ['user-feedback', 'feedback:down', 'feedback:up', 'portal:a1b2c3d4e5f6']) {
      expect(isOwnLabel(own), own).toBe(true)
    }
    for (const alien of ['bug', 'триаж:разобрано', 'portal', 'portalzzz']) {
      expect(isOwnLabel(alien), alien).toBe(false)
    }
  })

  it('удаляет комментарии, обезличивает и сохраняет чужие метки', async () => {
    const { fn, calls } = fakeFetch([
      ['GET /issues/7/comments', { status: 200, json: [{ id: 11 }, { id: 12 }] }],
      ['DELETE /issues/comments/', { status: 204 }],
      ['PATCH /issues/7', { status: 200 }]
    ])
    expect(await redactFeedbackIssue(config, issue, fn)).toBe(true)
    // Комментарии — не украшение: агент разбора цитирует в них контекст отзыва, и без удаления
    // «обезличивание» оставляло бы данные клиента в открытом виде.
    expect(calls.filter(c => c.method === 'DELETE').length).toBe(2)
    const patch = calls.find(c => c.method === 'PATCH')!.body as { labels: string[], state: string }
    expect(patch.labels).toEqual(['триаж:разобрано', 'bug'])
    expect(patch.state).toBe('closed')
  })

  it('комментарии не удалились — задачу не обезличиваем', async () => {
    // Иначе тело стёрто, а процитированный в комментарии контекст остался — и отчёт зелёный.
    const { fn, calls } = fakeFetch([
      ['GET /issues/7/comments', { status: 200, json: [{ id: 11 }] }],
      ['DELETE /issues/comments/', { status: 500 }]
    ])
    expect(await redactFeedbackIssue(config, issue, fn)).toBe(false)
    expect(calls.some(c => c.method === 'PATCH')).toBe(false)
  })

  it('комментариев нет — это успех', async () => {
    const { fn } = fakeFetch([['GET /issues/7/comments', { status: 200, json: [] }]])
    expect(await deleteIssueComments(config, 7, fn)).toBe(true)
  })
})

describe('#417: выборка задач', () => {
  it('берёт самые старые, читает метки и заголовок, пропускает запросы на слияние', async () => {
    const { fn, calls } = fakeFetch([['GET /issues?', { status: 200, json: [
      { number: 1, node_id: 'n1', created_at: '2024-01-01T00:00:00Z', title: 'Отзыв сотрудника', body: 'b', labels: [{ name: 'user-feedback' }] },
      { number: 2, node_id: 'n2', created_at: '2024-02-01T00:00:00Z', title: 'PR', pull_request: {} },
      { number: 3, node_id: '', created_at: '2024-03-01T00:00:00Z', title: 'без id' }
    ] }]])
    const out = await listOldestFeedbackIssues(config, 50, fn)
    expect(out?.map(i => i.number)).toEqual([1])
    expect(out?.[0]!.labels).toEqual(['user-feedback'])
    // Сортировка по возрастанию даты — иначе чистка годами не доходила бы до тех, ради кого заведена.
    expect(calls[0]!.url).toContain('direction=asc')
  })

  it('отказ приёмника — null, а не пустой список', async () => {
    const { fn } = fakeFetch([['GET /issues?', { status: 403 }]])
    expect(await listOldestFeedbackIssues(config, 50, fn)).toBeNull()
  })
})
