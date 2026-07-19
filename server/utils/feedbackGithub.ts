import type { FetchFn } from './b24Rest'
import type { FeedbackConfig } from './feedbackConfig'
import type { IssuePayload } from '~/utils/feedback'

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

export interface DedupLookup {
  /** True when an issue whose title carries this dedup code already exists in the repo. */
  found: boolean
  number?: number
  url?: string
}

/**
 * Search the receiving repo for an existing feedback issue carrying `code` in its title (#192 dedup).
 * FAIL-OPEN by design: any error / rate-limit / non-200 returns `found:false` so a search hiccup never
 * blocks a genuine submission (a rare duplicate is cheaper than a lost report). Matches OPEN and CLOSED
 * (a triaged/closed dup must still suppress a re-file). NB: GitHub's search index is eventually
 * consistent, so two near-simultaneous submits can both miss — the widget's local sent-flag covers the
 * common double-click; cross-reload races are rare and self-heal on the next submit. Never logs token/URL.
 */
export async function findFeedbackIssueByCode(config: FeedbackConfig, code: string, fetchFn: FetchFn): Promise<DedupLookup> {
  if (!code) return { found: false }
  const q = encodeURIComponent(`repo:${config.repo} in:title ${code}`)
  let res: Awaited<ReturnType<FetchFn>>
  try {
    res = await fetchFn(`https://api.github.com/search/issues?q=${q}&per_page=1`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.token}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'procure-ai-feedback',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    })
  } catch {
    return { found: false } // network error → fail-open (proceed to create)
  }
  if (res.status !== 200) return { found: false } // rate-limit / error → fail-open
  const body = await res.json().catch(() => null) as { items?: Array<{ number?: unknown, html_url?: unknown }> } | null
  const item = body?.items?.[0]
  if (!item) return { found: false }
  const number = Number(item.number)
  return { found: true, ...(Number.isInteger(number) && number > 0 ? { number } : {}), url: typeof item.html_url === 'string' ? item.html_url : undefined }
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
        'User-Agent': 'procure-ai-feedback',
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
