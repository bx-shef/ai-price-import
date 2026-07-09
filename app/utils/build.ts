/** Pure builder for the health/build payload (covered by tests). */
export interface HealthInfo {
  status: 'ok'
  commit: string
  commitUrl: string | null
}

const REPO_URL = 'https://github.com/bx-shef/ai-price-import'

/** Build health info from a commit sha ('dev' in local/dev). */
export function healthInfo(commit: string | undefined): HealthInfo {
  const sha = commit && commit.trim() ? commit.trim() : 'dev'
  return {
    status: 'ok',
    commit: sha,
    commitUrl: sha === 'dev' ? null : `${REPO_URL}/commit/${sha}`
  }
}
