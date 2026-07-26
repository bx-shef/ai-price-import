import { describe, expect, it } from 'vitest'
import { commitFeedbackFile } from '../server/utils/feedbackGithub'
import type { FetchFn } from '../server/utils/b24Rest'
import type { FeedbackConfig } from '../server/utils/feedbackConfig'

const config: FeedbackConfig = { token: 'ghp_x', repo: 'bx-shef/ai-price-import-feedback' }

/** Fake FetchFn capturing the request and returning a canned response. */
function fake(status: number, body: unknown, capture?: (url: string, init?: { method?: string, body?: string }) => void): FetchFn {
  return async (url, init) => {
    capture?.(url, init)
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }
}

describe('commitFeedbackFile', () => {
  it('PUTs to the contents API and returns the committed file html_url on 201', async () => {
    let seenUrl = ''
    let seenInit: { method?: string, body?: string } | undefined
    const fetchFn = fake(201, { content: { html_url: 'https://github.com/bx-shef/ai-price-import-feedback/blob/main/files/j1/a.pdf' } },
      (u, i) => {
        seenUrl = u
        seenInit = i
      })
    const r = await commitFeedbackFile(config, 'files/j1/a.pdf', 'YmFzZTY0', 'msg', fetchFn)
    expect(r.ok).toBe(true)
    expect(r.htmlUrl).toContain('/files/j1/a.pdf')
    expect(seenUrl).toBe('https://api.github.com/repos/bx-shef/ai-price-import-feedback/contents/files/j1/a.pdf')
    expect(seenInit?.method).toBe('PUT')
    const sent = JSON.parse(seenInit!.body!)
    expect(sent).toMatchObject({ content: 'YmFzZTY0', message: 'msg' })
  })

  it('non-2xx (e.g. 422 already exists) → not ok, no throw', async () => {
    const r = await commitFeedbackFile(config, 'files/j1/a.pdf', 'x', 'm', fake(422, {}))
    expect(r).toEqual({ ok: false, status: 422 })
  })

  it('network error → ok:false status:0 (never throws / leaks)', async () => {
    const fetchFn: FetchFn = async () => {
      throw new Error('boom')
    }
    expect(await commitFeedbackFile(config, 'p', 'x', 'm', fetchFn)).toEqual({ ok: false, status: 0 })
  })
})
