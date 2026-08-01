import type { FetchFn } from './b24Rest'
import type { FeedbackConfig } from './feedbackConfig'

// Privacy probe for the feedback receiver (#200). The byte-upload commits REAL client documents —
// invoices with counterparty names, tax ids and prices — into `GITHUB_FEEDBACK_REPO`. Everything else
// about that repo is taken on trust from an env var, so one typo in the slug (or the repo's visibility
// being flipped later) publishes customer paperwork. Ask GitHub instead of assuming: upload only when
// the repo answers `private: true`.
//
// THREE-STATE on purpose. `null` ("could not verify" — network error, 5xx, bad token) is NOT the same
// as `false`, and both block the upload, but only `false` is a settled answer worth caching for long:
// an unreachable API must be retried soon, or one blip would disable file attachments until restart.
//
// The issue itself is still filed without the file — a missing attachment is an inconvenience, a leaked
// invoice is not recoverable.
//
// SECURITY: like the rest of this channel, never log the token, the URL or the body — only the status.

export type RepoPrivacy = boolean | null

interface CacheEntry { value: RepoPrivacy, at: number }

/** A settled answer is stable enough to hold for an hour; visibility changes are rare and manual. */
export const PRIVACY_TTL_MS = 60 * 60 * 1000
/** An unverifiable answer is re-probed within a minute — a blip must not disable uploads for an hour. */
export const PRIVACY_MISS_TTL_MS = 60 * 1000

const cache = new Map<string, CacheEntry>()

/** Ask GitHub whether the receiving repo is private. `null` = the answer is unknown, not "public". */
export async function probeRepoPrivacy(config: FeedbackConfig, fetchFn: FetchFn): Promise<RepoPrivacy> {
  let res: Awaited<ReturnType<FetchFn>>
  try {
    res = await fetchFn(`https://api.github.com/repos/${config.repo}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.token}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'procure-ai-feedback',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    })
  } catch {
    return null // network — unknown, not "public"
  }
  if (res.status !== 200) return null // 401/403/404/5xx — unknown; a wrong token must not read as public
  const priv = await res.json()
    .then((j: unknown) => (j as { private?: unknown })?.private)
    .catch(() => undefined)
  // Strictly the boolean GitHub documents. Anything else (missing field, truthy string) is unknown —
  // coercing here is exactly how a "private" verdict gets invented for a public repo.
  return typeof priv === 'boolean' ? priv : null
}

/**
 * Cached gate for the byte-upload: true ONLY when the receiver is verifiably private.
 * `now` is injectable so the TTL is testable without waiting.
 */
export async function feedbackUploadAllowed(config: FeedbackConfig, fetchFn: FetchFn, now: number = Date.now()): Promise<boolean> {
  const hit = cache.get(config.repo)
  if (hit && now - hit.at < (hit.value === null ? PRIVACY_MISS_TTL_MS : PRIVACY_TTL_MS)) return hit.value === true
  const value = await probeRepoPrivacy(config, fetchFn)
  cache.set(config.repo, { value, at: now })
  if (value !== true) {
    // One line, no token/URL/body — enough for the owner to notice a misconfigured receiver.
    console.warn(`[feedback] загрузка исходных файлов отключена: репозиторий-приёмник ${value === false ? 'ПУБЛИЧНЫЙ' : 'не удалось проверить'}`)
  }
  return value === true
}

/** Test seam: drop the memoised verdicts. */
export function resetRepoPrivacyCache(): void {
  cache.clear()
}
