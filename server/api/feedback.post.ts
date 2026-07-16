import { extractFrameAuth } from '../utils/frameAuth'
import { resolveFrameMember } from '../utils/resolveFrameMember'
import { resolveFeedbackConfig } from '../utils/feedbackConfig'
import { postFeedbackIssue } from '../utils/feedbackGithub'
import { buildFeedbackIssue, normalizeKind } from '~/utils/feedback'
import { query } from '../db/client'
import type { FetchFn } from '../utils/b24Rest'

// POST /api/feedback — employee 👍/👎 + comment on the import result → a GitHub issue in the
// configured PRIVATE receiving repo (#182 channel «сотрудник»). Frame-token authenticated (the
// submitter is in-portal). Channel-gated: no config → 503 (widget is hidden client-side too).
export default defineEventHandler(async (event) => {
  const config = resolveFeedbackConfig()
  if (!config) {
    setResponseStatus(event, 503)
    return { error: 'канал отзывов не настроен' }
  }
  // Auth: prove the submitter belongs to a real installed portal (blocks anonymous spam).
  const auth = extractFrameAuth(getHeaders(event) as Record<string, string | undefined>)
  if (!auth) {
    setResponseStatus(event, 401)
    return { error: 'frame auth required' }
  }
  const member = await resolveFrameMember(auth, { fetchFn: globalThis.fetch as unknown as FetchFn, query })
  if (!member.ok || !member.memberId) {
    setResponseStatus(event, member.status ?? 401)
    return { error: 'authorization failed', reason: member.reason }
  }

  const raw = await readBody(event).catch(() => null) as { kind?: unknown, comment?: unknown } | null
  const kind = normalizeKind(raw?.kind)
  if (!kind) {
    setResponseStatus(event, 400)
    return { error: 'неизвестная оценка' }
  }
  const payload = buildFeedbackIssue(kind, raw?.comment)
  const result = await postFeedbackIssue(config, payload, globalThis.fetch as unknown as FetchFn)
  if (result.ok) return { ok: true, number: result.number }
  // Never surface GitHub's body/URL/token — only a generic message + the retry hint.
  console.warn(`[feedback] github issue failed: status=${result.status} retryable=${result.retryable}`)
  setResponseStatus(event, result.retryable ? 502 : 500)
  return { error: 'не удалось отправить отзыв' }
})
