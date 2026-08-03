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

/**
 * What to tell a person when there is no frame token (#345).
 *
 * Two different situations were collapsed into one message. Inside a portal the old text —
 * «доступно только внутри портала Bitrix24» — is not merely unhelpful, it contradicts what the
 * person is looking at: the app IS open in the portal. The fix that helps is a page reload, so the
 * message says that instead of naming our own subsystem.
 *
 * `inFrame` is what separates the cases, and it was available all along.
 *
 * ⚠ `subject` is the WHOLE phrase («Импорт доступен», «Настройки доступны»), not a bare noun.
 * Gluing a fixed «доступен» onto a caller-supplied noun produced «Настройки доступен» — Russian
 * agreement broke exactly where the old code had it right, and the first version of the test pinned
 * the broken form, so fixing the grammar would have failed CI.
 */
export function frameAuthMessage(inFrame: boolean, subject: string): string {
  return inFrame
    ? 'Сессия портала истекла. Обновите страницу и повторите.'
    : `${subject} только внутри портала Bitrix24`
}
