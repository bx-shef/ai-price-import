import { dbEnabled, query } from '../../db/client'
import { extractEvent, parseBracketForm } from '~/utils/b24Events'
import { decideB24Event } from '../../utils/b24EventsHandler'
import { deletePortal, getApplicationToken, saveToken } from '../../utils/tokenStore'
import { purgePortalFiles } from '../../utils/nodeFileIO'
import { encryptSecret } from '../../utils/secretCrypto'
import { verifyInstallToken } from '../../utils/verifyInstallToken'
import type { FetchFn } from '../../utils/b24Rest'

// B24 outgoing-event webhook: ONAPPINSTALL / ONAPPUNINSTALL.
// Verifies application_token (fail-closed) then applies register/unregister.
// Online events are not retried by B24 → we write synchronously here (no queue dependency).
export default defineEventHandler(async (event) => {
  const cfg = useRuntimeConfig()
  const body = await readRawBody(event, 'utf8') || ''
  const ev = extractEvent(parseBracketForm(body))

  // Trust model (B24 «Безопасность в обработчиках»): a known portal is verified
  // against ITS stored application_token; a first install is authenticated via the
  // delivered access_token (application_token is learned, not pre-shared). The env
  // token is an OPTIONAL extra gate on first install — normally empty.
  const envToken = String(cfg.b24ApplicationToken || '')
  const storedToken = (dbEnabled() && ev.memberId) ? await getApplicationToken(ev.memberId, query) : null
  const decision = decideB24Event(ev, storedToken, envToken)
  setResponseStatus(event, decision.status)

  if (decision.action === 'ignore') {
    return { ok: decision.status === 200 }
  }
  if (!dbEnabled()) {
    // Without a DB we cannot persist; report unconfigured rather than lose silently.
    setResponseStatus(event, 503)
    return { ok: false, error: 'no database' }
  }

  const auth = ev.auth as Record<string, unknown>

  // First install: prove the delivered access_token controls the portal before we
  // remember its application_token (an attacker cannot forge a working OAuth token).
  if (decision.verifyAccessToken) {
    const verdict = await verifyInstallToken(
      ev.domain || String(auth.domain ?? ''),
      String(auth.access_token ?? ''),
      globalThis.fetch as unknown as FetchFn
    )
    if (!verdict.ok) {
      setResponseStatus(event, verdict.status ?? 403)
      return { ok: false, error: 'install verification failed' }
    }
  }

  if (decision.action === 'unregister') {
    await deletePortal(ev.memberId, query) // DB rows (tokens, jobs, text, docs, metrics)
    await purgePortalFiles(ev.memberId) // on-disk uploaded bytes (best-effort)
    return { ok: true }
  }

  // register: persist tokens (refresh encrypted at rest).
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
