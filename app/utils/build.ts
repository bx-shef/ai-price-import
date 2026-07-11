/** Pure builder for the health/build payload (covered by tests). */
export interface HealthInfo {
  status: 'ok'
  commit: string
  commitUrl: string | null
}

const REPO_URL = 'https://github.com/bx-shef/ai-price-import'

/** First 7 chars of a commit sha for compact display (footer). '' when unknown. */
export function shortSha(sha: string | undefined | null): string {
  return (sha ?? '').trim().slice(0, 7)
}

/** Link to the exact build commit, or the repo root when the sha is unknown/'dev'. */
export function commitUrl(sha: string | undefined | null): string {
  const s = (sha ?? '').trim()
  return s && s !== 'dev' ? `${REPO_URL}/commit/${s}` : REPO_URL
}

/** Build health info from a commit sha ('dev' in local/dev). */
export function healthInfo(commit: string | undefined): HealthInfo {
  const sha = commit && commit.trim() ? commit.trim() : 'dev'
  return {
    status: 'ok',
    commit: sha,
    commitUrl: sha === 'dev' ? null : commitUrl(sha)
  }
}
