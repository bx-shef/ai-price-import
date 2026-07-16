import { describe, expect, it, vi } from 'vitest'
import { resolveFeedbackConfig } from '../server/utils/feedbackConfig'
import { postFeedbackIssue } from '../server/utils/feedbackGithub'

describe('resolveFeedbackConfig', () => {
  it('null when no token (channel disabled)', () => {
    expect(resolveFeedbackConfig({ GITHUB_FEEDBACK_REPO: 'owner/private' })).toBeNull()
  })
  it('null when repo missing or malformed (fail-closed — never defaults to a repo)', () => {
    expect(resolveFeedbackConfig({ GITHUB_FEEDBACK_TOKEN: 't' })).toBeNull()
    expect(resolveFeedbackConfig({ GITHUB_FEEDBACK_TOKEN: 't', GITHUB_FEEDBACK_REPO: 'notarepo' })).toBeNull()
    expect(resolveFeedbackConfig({ GITHUB_FEEDBACK_TOKEN: 't', GITHUB_FEEDBACK_REPO: 'a/b/c' })).toBeNull()
  })
  it('resolves when token + valid repo', () => {
    expect(resolveFeedbackConfig({ GITHUB_FEEDBACK_TOKEN: '  tok ', GITHUB_FEEDBACK_REPO: 'bx-shef/feedback-private' }))
      .toEqual({ token: 'tok', repo: 'bx-shef/feedback-private' })
  })
})

describe('postFeedbackIssue', () => {
  const cfg = { token: 'tok', repo: 'o/r' }
  const payload = { title: 't', body: 'b', labels: ['user-feedback', 'feedback:up'] }

  it('201 → ok + issue number; posts to the repo issues endpoint with Bearer auth', async () => {
    const fetchFn = vi.fn(async () => ({ status: 201, json: async () => ({ number: 42 }) }) as never)
    const r = await postFeedbackIssue(cfg, payload, fetchFn)
    expect(r).toEqual({ ok: true, status: 201, number: 42, retryable: false })
    const [url, opts] = fetchFn.mock.calls[0]!
    expect(url).toBe('https://api.github.com/repos/o/r/issues')
    expect((opts as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer tok')
  })
  it('5xx / 429 → retryable; 403 → not retryable', async () => {
    const f500 = vi.fn(async () => ({ status: 500, json: async () => ({}) }) as never)
    expect((await postFeedbackIssue(cfg, payload, f500)).retryable).toBe(true)
    const f429 = vi.fn(async () => ({ status: 429, json: async () => ({}) }) as never)
    expect((await postFeedbackIssue(cfg, payload, f429)).retryable).toBe(true)
    const f403 = vi.fn(async () => ({ status: 403, json: async () => ({}) }) as never)
    const r = await postFeedbackIssue(cfg, payload, f403)
    expect(r).toMatchObject({ ok: false, status: 403, retryable: false })
  })
  it('network error → retryable, status 0 (no token/url leaked in the result)', async () => {
    const fThrow = vi.fn(async () => {
      throw new Error('ECONNRESET https://api.github.com/... tok')
    })
    const r = await postFeedbackIssue(cfg, payload, fThrow as never)
    expect(r).toEqual({ ok: false, status: 0, retryable: true })
    expect(JSON.stringify(r)).not.toContain('tok')
  })
})
