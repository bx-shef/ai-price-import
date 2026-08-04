import type { FetchFn } from './b24Rest'
import type { FeedbackConfig } from './feedbackConfig'
import type { IssuePayload } from '~/utils/feedback'
import { APP_SLUG } from '~/config/appIdentity'

// Transport: POST the built issue to the GitHub REST API. DI over FetchFn (tested with a fake).
// SECURITY: never log the token, the request URL or the response body. Only the numeric status is
// surfaced. Retryable on transient transport (5xx / 429); auth/validation (401/403/404/422) are not.

export interface PostIssueResult {
  ok: boolean
  status: number
  /** Issue number on success. */
  number?: number
  /** Could a later retry plausibly succeed (drives a future durable outbox)? */
  retryable: boolean
}

export async function postFeedbackIssue(config: FeedbackConfig, payload: IssuePayload, fetchFn: FetchFn): Promise<PostIssueResult> {
  let res: Awaited<ReturnType<FetchFn>>
  try {
    res = await fetchFn(`https://api.github.com/repos/${config.repo}/issues`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.token}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': `${APP_SLUG}-feedback`,
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify(payload)
    })
  } catch {
    // Network error — transient, retryable. Do not include the error (may echo the URL/token).
    return { ok: false, status: 0, retryable: true }
  }
  const status = res.status
  if (status === 201) {
    const num = await res.json().then((j: unknown) => Number((j as { number?: unknown })?.number)).catch(() => Number.NaN)
    return { ok: true, status, retryable: false, ...(Number.isInteger(num) && num > 0 ? { number: num } : {}) }
  }
  return { ok: false, status, retryable: status >= 500 || status === 429 }
}

export interface CommitFileResult {
  ok: boolean
  status: number
  /** Blob URL of the committed file in the (private) repo, for linking in the issue. */
  htmlUrl?: string
}

/**
 * Commit a base64 file into the PRIVATE feedback repo via the Contents API (#332 byte-upload). Used to
 * attach the actual source document to a feedback issue — unlike a portal-Disk link, a file in the
 * owner's own repo IS accessible to them. DI over FetchFn. SECURITY: never log the token/URL/body.
 * Idempotent-ish: a repeated same-path PUT without a sha 422s (already exists) — treated as non-ok,
 * best-effort (the caller still files the issue).
 */
export async function commitFeedbackFile(config: FeedbackConfig, path: string, contentBase64: string, message: string, fetchFn: FetchFn): Promise<CommitFileResult> {
  let res: Awaited<ReturnType<FetchFn>>
  try {
    res = await fetchFn(`https://api.github.com/repos/${config.repo}/contents/${path}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${config.token}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': `${APP_SLUG}-feedback`,
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify({ message, content: contentBase64 })
    })
  } catch {
    return { ok: false, status: 0 }
  }
  const status = res.status
  if (status === 201 || status === 200) {
    const html = await res.json()
      .then((j: unknown) => String((j as { content?: { html_url?: unknown } })?.content?.html_url ?? ''))
      .catch(() => '')
    return { ok: true, status, ...(html ? { htmlUrl: html } : {}) }
  }
  return { ok: false, status }
}
