import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PRIVACY_MISS_TTL_MS,
  PRIVACY_TTL_MS,
  feedbackUploadAllowed,
  probeRepoPrivacy,
  resetRepoPrivacyCache
} from '../server/utils/feedbackRepoPrivacy'
import type { FetchFn } from '../server/utils/b24Rest'

// #200: the byte-upload commits REAL client invoices into GITHUB_FEEDBACK_REPO. The slug is an env
// var and nothing else verifies it, so a typo — or someone flipping the repo to public later —
// publishes customer paperwork. These tests pin the gate that asks GitHub instead of assuming.

const CONFIG = { token: 'secret-token', repo: 'owner/private-receiver' }

const fakeFetch = (impl: (url: string) => { status: number, body?: unknown } | Promise<never>): FetchFn =>
  (async (url: string) => {
    const r = await impl(url)
    return { status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body ?? '') }
  }) as unknown as FetchFn

beforeEach(() => resetRepoPrivacyCache())

describe('probeRepoPrivacy', () => {
  it('приватный репозиторий распознаётся', async () => {
    expect(await probeRepoPrivacy(CONFIG, fakeFetch(() => ({ status: 200, body: { private: true } })))).toBe(true)
  })

  it('публичный распознаётся как публичный, а не как «непонятно»', async () => {
    expect(await probeRepoPrivacy(CONFIG, fakeFetch(() => ({ status: 200, body: { private: false } })))).toBe(false)
  })

  it('спрашивает именно тот репозиторий, куда потом коммитит', async () => {
    let asked = ''
    await probeRepoPrivacy(CONFIG, fakeFetch((url) => {
      asked = url
      return { status: 200, body: { private: true } }
    }))
    expect(asked).toBe('https://api.github.com/repos/owner/private-receiver')
  })

  it.each([401, 403, 404, 500, 503])('ошибка %i — «не удалось проверить», а НЕ «публичный» и не «приватный»', async (status) => {
    // Важно, что это null, а не false/true: неверный токен не должен читаться как «репо публичный»
    // (лишняя паника), и тем более не как «приватный» (утечка).
    expect(await probeRepoPrivacy(CONFIG, fakeFetch(() => ({ status })))).toBeNull()
  })

  it('сетевой сбой — «не удалось проверить»', async () => {
    const boom = (async () => {
      throw new Error('network')
    }) as unknown as FetchFn
    expect(await probeRepoPrivacy(CONFIG, boom)).toBeNull()
  })

  it.each([
    ['поле отсутствует', {}],
    ['строка вместо булева', { private: 'true' }],
    ['null', { private: null }],
    ['тело не объект', 'nope']
  ])('%s → «не удалось проверить» (приватность не выдумывается из truthy-значения)', async (_case, body) => {
    expect(await probeRepoPrivacy(CONFIG, fakeFetch(() => ({ status: 200, body })))).toBeNull()
  })
})

describe('feedbackUploadAllowed — загрузка только в подтверждённо приватный приёмник', () => {
  it('разрешает только при private:true', async () => {
    expect(await feedbackUploadAllowed(CONFIG, fakeFetch(() => ({ status: 200, body: { private: true } })))).toBe(true)
  })

  it('ЗАПРЕЩАЕТ публичный — это и есть защита от утечки счетов клиента', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await feedbackUploadAllowed(CONFIG, fakeFetch(() => ({ status: 200, body: { private: false } })))).toBe(false)
    expect(warn.mock.calls[0]?.[0]).toContain('ПУБЛИЧНЫЙ')
    warn.mockRestore()
  })

  it('ЗАПРЕЩАЕТ и при неизвестном ответе — «не проверили» не значит «можно»', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await feedbackUploadAllowed(CONFIG, fakeFetch(() => ({ status: 500 })))).toBe(false)
    warn.mockRestore()
  })

  it('не логирует токен ни при каком исходе', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await feedbackUploadAllowed(CONFIG, fakeFetch(() => ({ status: 200, body: { private: false } })))
    expect(JSON.stringify(warn.mock.calls)).not.toContain(CONFIG.token)
    warn.mockRestore()
  })

  it('решённый ответ кэшируется — не спрашиваем GitHub на каждый отзыв', async () => {
    let calls = 0
    const f = fakeFetch(() => {
      calls += 1
      return { status: 200, body: { private: true } }
    })
    await feedbackUploadAllowed(CONFIG, f, 1000)
    await feedbackUploadAllowed(CONFIG, f, 1000 + PRIVACY_TTL_MS - 1)
    expect(calls).toBe(1)
    await feedbackUploadAllowed(CONFIG, f, 1000 + PRIVACY_TTL_MS)
    expect(calls).toBe(2) // видимость могли поменять — переспрашиваем
  })

  it('НЕпроверенный ответ переспрашивается быстро — один сбой сети не отключает вложения на час', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let calls = 0
    const f = fakeFetch(() => {
      calls += 1
      return calls === 1 ? { status: 500 } : { status: 200, body: { private: true } }
    })
    expect(await feedbackUploadAllowed(CONFIG, f, 1000)).toBe(false)
    expect(await feedbackUploadAllowed(CONFIG, f, 1000 + PRIVACY_MISS_TTL_MS)).toBe(true)
    expect(calls).toBe(2)
    warn.mockRestore()
  })

  it('смена приёмника не наследует чужой вердикт', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = fakeFetch(url => ({ status: 200, body: { private: url.endsWith('private-receiver') } }))
    expect(await feedbackUploadAllowed(CONFIG, f)).toBe(true)
    expect(await feedbackUploadAllowed({ ...CONFIG, repo: 'owner/public-repo' }, f)).toBe(false)
    warn.mockRestore()
  })
})
