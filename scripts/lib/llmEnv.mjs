import { readFileSync } from 'node:fs'

// Loads the LLM provider variables from the git-ignored `.env` into `process.env`.
//
// ⚠ One copy, not three. The same block lived in `verify-chat.mjs` and `ab-prompt.mjs`, and
// `live-crm-sync.mjs` had NONE — its header promised «LLM provider from env», but nothing ever read
// the file its siblings read, so `pnpm live:crm --ai` died with «нет ключа» on a machine where
// `pnpm verify:chat` worked. Two copies of a loader diverge quietly; a missing third one fails
// exactly when the check is needed.
//
// ⚠ Keys are enumerated, not swept from the file: `.env` also carries portal and operator secrets,
// and hoisting the whole file into the process would put them in reach of everything downstream.
const ENV_KEYS = [
  'LLM_PROVIDER',
  'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL',
  'BITRIXGPT_API_KEY', 'VIBE_API_KEY', 'BITRIXGPT_BASE_URL', 'BITRIXGPT_MODEL',
  'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_LABEL'
]

/**
 * Copy the provider vars from `.env` into `process.env`.
 *
 * ⚠ Values already present in the ambient environment WIN — a shell `DEEPSEEK_API_KEY=… pnpm …`
 * must not be silently overridden by a stale line in the file.
 * ⚠ No `.env` is not an error: CI and the owner's server pass these as real environment variables.
 */
export function loadLlmEnv(file = '.env') {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return
  }
  for (const key of ENV_KEYS) {
    if (process.env[key]) continue
    // Anchored to line start so a commented `#KEY=…` or a longer name ending in KEY can't match.
    const m = text.match(new RegExp(`^\\s*${key}=(.+)$`, 'm'))
    if (m) process.env[key] = m[1].trim().replace(/^["']|["']$/g, '')
  }
}
