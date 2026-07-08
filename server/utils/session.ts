import { createHmac, timingSafeEqual } from 'node:crypto'

// Operator-zone auth (staff sign-in to /queues etc — NOT the B24 iframe / landing).
// Pure logic: constant-time credential check + HMAC-signed session cookie. All time
// is injected → unit-tested. Ported model from postroyka/purchase-ai-chat. docs AUTH.

export interface AuthConfig { password: string, secret: string }

/** Resolve operator auth from env. Empty password ⇒ sign-in disabled. */
export function resolveAuthConfig(env: Record<string, string | undefined>): AuthConfig {
  return {
    password: env.OPERATOR_PASSWORD ?? '',
    secret: env.OPERATOR_SESSION_SECRET ?? env.B24_TOKEN_ENC_KEY ?? ''
  }
}

/** Constant-time password check. Disabled (always false) when no password is set. */
export function checkCredentials(password: string, config: AuthConfig): boolean {
  if (!config.password) return false
  const a = Buffer.from(String(password ?? ''))
  const b = Buffer.from(config.password)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

const SEP = '.'

/** Sign a session token: base64url("<issuedAtMs>") + "." + HMAC-SHA256. */
export function signSession(secret: string, now: number): string {
  const body = Buffer.from(String(now)).toString('base64url')
  const mac = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}${SEP}${mac}`
}

export interface SessionVerdict { valid: boolean, issuedAt?: number }

/** Verify a session token: HMAC match (constant-time) AND within maxAgeMs. */
export function verifySession(token: string, secret: string, now: number, maxAgeMs: number): SessionVerdict {
  if (!secret || !token) return { valid: false }
  const i = token.lastIndexOf(SEP)
  if (i <= 0) return { valid: false }
  const body = token.slice(0, i)
  const mac = token.slice(i + 1)
  const expected = createHmac('sha256', secret).update(body).digest('base64url')
  const a = Buffer.from(mac)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { valid: false }
  const issuedAt = Number(Buffer.from(body, 'base64url').toString())
  if (!Number.isFinite(issuedAt) || issuedAt > now || now - issuedAt > maxAgeMs) return { valid: false }
  return { valid: true, issuedAt }
}
