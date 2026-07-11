// Pure boot-time env validation (logged, non-fatal — same convention as the reference).
// See docs/redesign 02 §5 / reviewer note «нет envCheck».

export interface EnvReport {
  errors: string[]
  warnings: string[]
}

const PLACEHOLDERS = ['', 'change_me', 'changeme', 'todo', 'xxx', 'your_token_here']

/** Validate backend env. Returns errors (misconfig) + warnings (degraded). */
export function checkBackendEnv(env: Record<string, string | undefined>): EnvReport {
  const errors: string[] = []
  const warnings: string[] = []

  // Token encryption key must decode to exactly 32 bytes (AES-256).
  const key = env.B24_TOKEN_ENC_KEY ?? ''
  if (!key) {
    errors.push('B24_TOKEN_ENC_KEY is not set')
  } else {
    const len = Buffer.from(key, 'base64').length
    if (len !== 32) errors.push(`B24_TOKEN_ENC_KEY must decode to 32 bytes, got ${len}`)
  }

  if (!env.DATABASE_URL) errors.push('DATABASE_URL is not set')

  // B24_APPLICATION_TOKEN is OPTIONAL: application_token is delivered by ONAPPINSTALL
  // and remembered per-portal; a first install authenticates via its access_token
  // (see server/utils/verifyInstallToken). Empty is the normal setup. A LEFTOVER
  // placeholder is a footgun — it becomes a global gate that never matches, so every
  // first install 403s. Flag that, but treat empty as fine.
  const appToken = (env.B24_APPLICATION_TOKEN ?? '').trim()
  if (appToken && PLACEHOLDERS.includes(appToken.toLowerCase())) {
    errors.push('B24_APPLICATION_TOKEN is a placeholder — leave it empty or set a real token (else every install 403s)')
  }

  if (!env.B24_CLIENT_ID || !env.B24_CLIENT_SECRET) {
    warnings.push('B24_CLIENT_ID/SECRET unset — event intake works, but token refresh / app.option do not')
  }
  if (!env.REDIS_URL) {
    warnings.push('REDIS_URL unset — queue disabled (synchronous fallback only)')
  }

  // Operator zone: if sign-in is enabled, its session-signing secret must be strong.
  if (env.OPERATOR_PASSWORD) {
    const opSecret = env.OPERATOR_SESSION_SECRET ?? env.B24_TOKEN_ENC_KEY ?? ''
    if (opSecret.length < 16) {
      warnings.push('OPERATOR_PASSWORD is set but the session secret is weak/unset — set a strong OPERATOR_SESSION_SECRET (else cookies are forgeable)')
    } else if (!env.OPERATOR_SESSION_SECRET) {
      warnings.push('OPERATOR_SESSION_SECRET unset — reusing B24_TOKEN_ENC_KEY for session signing (key separation recommended in prod)')
    }
  }

  return { errors, warnings }
}
