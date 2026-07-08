import { dbEnabled, query } from '../../db/client'
import { extractEvent, parseBracketForm } from '~/utils/b24Events'
import { decideB24Event } from '../../utils/b24EventsHandler'
import { deletePortal, saveToken } from '../../utils/tokenStore'
import { encryptSecret } from '../../utils/secretCrypto'

// B24 outgoing-event webhook: ONAPPINSTALL / ONAPPUNINSTALL.
// Verifies application_token (fail-closed) then applies register/unregister.
// Online events are not retried by B24 → we write synchronously here (no queue dependency).
export default defineEventHandler(async (event) => {
  const cfg = useRuntimeConfig()
  const body = await readRawBody(event, 'utf8') || ''
  const ev = extractEvent(parseBracketForm(body))

  // Bootstrap: first install has no stored token, so the trusted value is the
  // app's configured application_token (env). Later events must match it too.
  const expected = String(cfg.b24ApplicationToken || '')
  const decision = decideB24Event(ev, expected)
  setResponseStatus(event, decision.status)

  if (decision.action === 'ignore') {
    return { ok: decision.status === 200 }
  }
  if (!dbEnabled()) {
    // Without a DB we cannot persist; report unconfigured rather than lose silently.
    setResponseStatus(event, 503)
    return { ok: false, error: 'no database' }
  }

  if (decision.action === 'unregister') {
    await deletePortal(ev.memberId, query)
    return { ok: true }
  }

  // register: persist tokens (refresh encrypted at rest).
  const auth = ev.auth as Record<string, unknown>
  const refresh = String(auth.refresh_token ?? '')
  const now = Date.now()
  await saveToken({
    memberId: ev.memberId,
    domain: ev.domain || String(auth.domain ?? ''),
    clientEndpoint: String(auth.client_endpoint ?? ''),
    accessToken: String(auth.access_token ?? ''),
    refreshTokenEnc: refresh ? encryptSecret(refresh, String(cfg.b24TokenEncKey || '')) : '',
    applicationToken: ev.applicationToken,
    expiresIn: Number(auth.expires_in ?? 3600),
    issuedAtMs: now,
    refreshedAtMs: now
  }, query)
  return { ok: true }
})
