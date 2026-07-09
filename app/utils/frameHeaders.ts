// Pure client helpers shared by the in-portal composables (single source → the
// server frame-auth parser can't drift from two copies). Tested.

export interface FrameAuth { accessToken: string, domain: string }

/** Build the frame-auth request headers the server (extractFrameAuth) expects, or
 * null when not authenticated (not in a portal / SDK not ready). */
export function buildFrameHeaders(auth: FrameAuth | null): Record<string, string> | null {
  return auth ? { 'Authorization': `Bearer ${auth.accessToken}`, 'X-B24-Domain': auth.domain } : null
}

/** Surface the server's `{ error }` body from an ofetch error, else a fallback. */
export function fetchErrorMessage(e: unknown, fallback: string): string {
  const m = (e as { data?: { error?: unknown } })?.data?.error
  return typeof m === 'string' && m.trim() ? m : fallback
}
