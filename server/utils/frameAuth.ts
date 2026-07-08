import { isSafeB24Domain } from './b24Rest'

// Frame-token auth for in-portal settings routes: the client sends the frame's
// access token + portal domain; B24 scopes that token to the caller's portal, so
// member_id is not trusted. Pure extraction/validation. docs/redesign 02 §8.

export interface FrameAuth { accessToken: string, domain: string }

/** Extract + validate frame auth from request headers. Null when absent/unsafe. */
export function extractFrameAuth(headers: Record<string, string | undefined>): FrameAuth | null {
  const auth = headers.authorization ?? headers.Authorization ?? ''
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim())
  const accessToken = m?.[1]?.trim() ?? ''
  const domain = (headers['x-b24-domain'] ?? headers['X-B24-Domain'] ?? '').trim()
  if (!accessToken || !domain) return null
  if (!isSafeB24Domain(domain)) return null // SSRF: only Bitrix24 hosts
  return { accessToken, domain }
}
