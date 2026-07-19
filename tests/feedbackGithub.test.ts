import { describe, expect, it, vi } from 'vitest'
import { findFeedbackIssueByCode } from '../server/utils/feedbackGithub'
import type { FeedbackConfig } from '../server/utils/feedbackConfig'

const config: FeedbackConfig = { token: 'tkn', repo: 'bx-shef/ai-price-import-feedback' }

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async (_url: string) => ({ status, json: async () => body })) as unknown as typeof globalThis.fetch
}

describe('findFeedbackIssueByCode (#192 dedup, fail-open)', () => {
  it('returns found + number/url when a titled issue matches', async () => {
    const f = fakeFetch(200, { items: [{ number: 7, html_url: 'https://github.com/x/y/issues/7' }] })
    expect(await findFeedbackIssueByCode(config, 'abc123', f)).toEqual({ found: true, number: 7, url: 'https://github.com/x/y/issues/7' })
  })
  it('returns not-found when the search is empty', async () => {
    expect(await findFeedbackIssueByCode(config, 'abc123', fakeFetch(200, { items: [] }))).toEqual({ found: false })
  })
  it('scopes the query to the repo + title + the code', async () => {
    const f = fakeFetch(200, { items: [] })
    await findFeedbackIssueByCode(config, 'abc123', f)
    const url = (f as unknown as { mock: { calls: string[][] } }).mock.calls[0]![0]
    expect(url).toContain('/search/issues?q=')
    expect(decodeURIComponent(url)).toContain('repo:bx-shef/ai-price-import-feedback in:title abc123')
  })
  it('fail-open on rate-limit / non-200 → not found (never blocks a submission)', async () => {
    expect(await findFeedbackIssueByCode(config, 'abc123', fakeFetch(403, {}))).toEqual({ found: false })
    expect(await findFeedbackIssueByCode(config, 'abc123', fakeFetch(422, {}))).toEqual({ found: false })
  })
  it('fail-open on a network throw', async () => {
    const f = vi.fn(async () => {
      throw new Error('net')
    }) as unknown as typeof globalThis.fetch
    expect(await findFeedbackIssueByCode(config, 'abc123', f)).toEqual({ found: false })
  })
  it('empty code → no search, not found', async () => {
    const f = fakeFetch(200, { items: [{ number: 1 }] })
    expect(await findFeedbackIssueByCode(config, '', f)).toEqual({ found: false })
    expect(f).not.toHaveBeenCalled()
  })
})
