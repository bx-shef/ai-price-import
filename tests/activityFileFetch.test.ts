import { describe, it, expect, vi } from 'vitest'
import { fetchActivityFile, type ActivityFileDeps } from '../server/utils/activityFileFetch'

const ORIGINATOR = 'SH_APP_IMPORT_PRICE_AI'
const OK_URL = 'https://b24-hrbvzq.bitrix24.by/rest/download.json?token=x'
const BYTES = new Uint8Array([37, 80, 68, 70]) // «%PDF»

function deps(over: Partial<ActivityFileDeps> = {}): ActivityFileDeps {
  return {
    call: vi.fn(async (method: string) => {
      if (method === 'crm.activity.list') return [{ ID: '77' }]
      return { FILES: [{ url: OK_URL, name: 'накладная.pdf', size: BYTES.length }] }
    }),
    download: vi.fn(async () => ({ status: 200, contentType: 'application/pdf', bytes: BYTES })),
    originatorCode: ORIGINATOR,
    maxBytes: 20 * 1024 * 1024,
    ...over
  }
}

describe('#461: файл к отзыву берётся из дела', () => {
  it('счастливый путь: дело найдено, байты скачаны, имя сохранено', async () => {
    const r = await fetchActivityFile('job-1', 17, deps())
    expect(r).toEqual({ ok: true, file: { name: 'накладная.pdf', base64: Buffer.from(BYTES).toString('base64') } })
  })

  it('выборка СУЖЕНА по сотруднику из фрейм-токена и помечена нашим маркером', async () => {
    // Несущая проверка приватности: `jobId` присылает клиент, и без сужения сотрудник, назвав
    // чужой идентификатор задания, вытянул бы ЧУЖОЙ документ — а отзыв ушёл бы успешно в обоих
    // случаях, то есть глазами это неотличимо.
    const call = vi.fn(async (method: string) => method === 'crm.activity.list'
      ? [{ ID: '77' }]
      : { FILES: [{ url: OK_URL, name: 'f.pdf' }] })
    await fetchActivityFile('job-1', 17, deps({ call }))
    const [, params] = call.mock.calls[0] as unknown as [string, { filter: Record<string, string> }]
    expect(params.filter).toEqual({ ORIGINATOR_ID: ORIGINATOR, ORIGIN_ID: 'job-1', RESPONSIBLE_ID: '17' })
  })

  it('сотрудник неизвестен → фильтр «0», а НЕ выборка по всему порталу', async () => {
    // Fail-closed: пустое сужение отдало бы первое попавшееся дело портала с этим jobId.
    const call = vi.fn(async () => [])
    await fetchActivityFile('job-1', undefined, deps({ call }))
    const [, params] = call.mock.calls[0] as unknown as [string, { filter: Record<string, string> }]
    expect(params.filter.RESPONSIBLE_ID).toBe('0')
  })

  it('ЛОВУШКА: страница входа приезжает с кодом 200 — файлом не считается', async () => {
    // Живая находка: портал отвечает на негодный токен `200 text/html`, а не 401. Проверка
    // `response.ok` отправила бы в репозиторий-приёмник страницу логина вместо счёта клиента.
    const r = await fetchActivityFile('job-1', 17, deps({
      download: async () => ({ status: 200, contentType: 'text/html; charset=UTF-8', bytes: new Uint8Array([60, 33]) })
    }))
    expect(r).toEqual({ ok: false, miss: 'login-page' })
  })

  it('адрес вне облака Битрикс24 не скачивается ВОВСЕ', async () => {
    // По адресу из ответа портала ходит НАШ процесс — подменённый увёл бы серверный запрос
    // на чужой хост.
    const download = vi.fn()
    for (const bad of ['https://evil.example/x', 'https://b24.bitrix24.by@evil.example/x', 'не адрес']) {
      const r = await fetchActivityFile('job-1', 17, deps({
        call: async (m: string) => m === 'crm.activity.list' ? [{ ID: '7' }] : { FILES: [{ url: bad }] },
        download: download as unknown as ActivityFileDeps['download']
      }))
      expect(r, bad).toEqual({ ok: false, miss: 'unsafe-url' })
    }
    expect(download).not.toHaveBeenCalled()
  })

  it('НЕуспешный код ответа — неудача, даже когда тип содержимого правильный', async () => {
    // Порядок проверок «страница входа → код ответа» иначе можно переставить незаметно: единственный
    // тест на страницу входа шёл с кодом 200, и обе ветки давали один и тот же исход.
    const r = await fetchActivityFile('job-1', 17, deps({
      download: async () => ({ status: 403, contentType: 'application/pdf', bytes: BYTES })
    }))
    expect(r).toEqual({ ok: false, miss: 'download-failed' })
  })

  it('слишком большой файл: заявленный размер отсекается ДО скачивания', async () => {
    const download = vi.fn()
    const r = await fetchActivityFile('job-1', 17, deps({
      maxBytes: 10,
      call: async (m: string) => m === 'crm.activity.list' ? [{ ID: '7' }] : { FILES: [{ url: OK_URL, size: 999 }] },
      download: download as unknown as ActivityFileDeps['download']
    }))
    expect(r).toEqual({ ok: false, miss: 'too-big' })
    expect(download, 'качать заведомо большой файл незачем').not.toHaveBeenCalled()
  })

  it('слишком большой файл: ФАКТИЧЕСКИЙ размер тоже проверяется', async () => {
    // Портал вправе не прислать `size` вовсе или соврать; верить можно только скачанному.
    const r = await fetchActivityFile('job-1', 17, deps({
      maxBytes: 2,
      call: async (m: string) => m === 'crm.activity.list' ? [{ ID: '7' }] : { FILES: [{ url: OK_URL }] }
    }))
    expect(r).toEqual({ ok: false, miss: 'too-big' })
  })

  it('дела нет / вложения нет / скачать не вышло — свой исход у каждого, без исключения наружу', async () => {
    // Отзыв ценнее вложения и обязан уйти в любом случае.
    const noAct = await fetchActivityFile('job-1', 17, deps({ call: async () => [] }))
    expect(noAct).toEqual({ ok: false, miss: 'no-activity' })

    const noFile = await fetchActivityFile('job-1', 17, deps({
      call: async (m: string) => m === 'crm.activity.list' ? [{ ID: '7' }] : { FILES: [] }
    }))
    expect(noFile).toEqual({ ok: false, miss: 'no-file' })

    const boom = await fetchActivityFile('job-1', 17, deps({
      download: async () => {
        throw new Error('сеть')
      }
    }))
    expect(boom).toEqual({ ok: false, miss: 'download-failed' })

    const empty = await fetchActivityFile('job-1', 17, deps({
      download: async () => ({ status: 200, contentType: 'application/pdf', bytes: new Uint8Array() })
    }))
    expect(empty).toEqual({ ok: false, miss: 'download-failed' })
  })

  it('имени в ответе портала НЕТ — берём имя из задания', async () => {
    // ⚠ Живая находка 08.08.2026: в `FILES` приезжают только `id` и `url`. Без запасного имени
    // документ уходил бы в отзыв как `job-9.bin`, и разобрать, что именно прислали, невозможно.
    const r = await fetchActivityFile('job-9', 17, deps({
      call: async (m: string) => m === 'crm.activity.list' ? [{ ID: '7' }] : { FILES: [{ url: OK_URL }] },
      fallbackName: 'накладная №5.pdf'
    }))
    expect(r).toEqual({ ok: true, file: { name: 'накладная №5.pdf', base64: Buffer.from(BYTES).toString('base64') } })
  })

  it('имени нет нигде → имя от задания, а не пустое', async () => {
    const r = await fetchActivityFile('job-9', 17, deps({
      call: async (m: string) => m === 'crm.activity.list' ? [{ ID: '7' }] : { FILES: [{ url: OK_URL, name: '  ' }] }
    }))
    expect(r).toEqual({ ok: true, file: { name: 'job-9.bin', base64: Buffer.from(BYTES).toString('base64') } })
  })
})
