import { dbEnabled, query } from '../../db/client'
import { extractEvent, parseBracketForm } from '~/utils/b24Events'
import { decideB24Event } from '../../utils/b24EventsHandler'
import { deletePortal, getApplicationToken, saveToken } from '../../utils/tokenStore'
import { purgePortalFiles } from '../../utils/nodeFileIO'
import { encryptSecret } from '../../utils/secretCrypto'
import { verifyInstallToken } from '../../utils/verifyInstallToken'
import { normaliseHost, type FetchFn } from '../../utils/b24Rest'

// B24 outgoing-event webhook: ONAPPINSTALL / ONAPPUNINSTALL.
// Verifies application_token (fail-closed) then applies register/unregister.
// Online events are not retried by B24 → we write synchronously here (no queue dependency).
export default defineEventHandler(async (event) => {
  const body = await readRawBody(event, 'utf8') || ''
  const ev = extractEvent(parseBracketForm(body))

  // Secrets come from process.env (bare names), NOT useRuntimeConfig(): Nuxt only
  // overrides runtimeConfig from NUXT_-prefixed vars, but the deploy sets bare
  // B24_TOKEN_ENC_KEY / B24_APPLICATION_TOKEN (env_file .env) — same as worker.ts /
  // envCheck. Reading them via cfg would silently see '' and 500 every install.

  // Trust model (B24 «Безопасность в обработчиках»): a known portal is verified
  // against ITS stored application_token; a first install is authenticated via the
  // delivered access_token (application_token is learned, not pre-shared). The env
  // token is an OPTIONAL extra gate on first install — normally empty.
  const envToken = process.env.B24_APPLICATION_TOKEN ?? ''
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
  // KNOWN LIMITATION (low-sev, tracked): verifyInstallToken proves control of ev.domain,
  // but we store under the client-supplied ev.memberId without binding member_id↔domain.
  // An attacker who controls any real portal could pre-seed a row for a NOT-YET-installed
  // victim's member_id (with their own application_token, write-once), so the victim's
  // later genuine install 403s on the known-portal branch — a targeted install-poisoning
  // DoS (no hijack/data-theft; needs the victim's member_id + un-installed state). Full
  // fix = authenticate member_id from a trusted source (OAuth token exchange returns
  // member_id) instead of trusting the event field. Deferred — not a deploy blocker.
  const refresh = String(auth.refresh_token ?? '')
  const now = Date.now()
  await saveToken({
    memberId: ev.memberId,
    // Normalised (bare lower-case host) so the frame-auth lookup (resolveFrameMember,
    // also normalised) matches regardless of case/scheme differences.
    domain: normaliseHost(ev.domain || String(auth.domain ?? '')),
    clientEndpoint: String(auth.client_endpoint ?? ''),
    accessToken: String(auth.access_token ?? ''),
    refreshTokenEnc: refresh ? encryptSecret(refresh, process.env.B24_TOKEN_ENC_KEY ?? '') : '',
    applicationToken: ev.applicationToken,
    expiresIn: Number(auth.expires_in ?? 3600),
    issuedAtMs: now,
    refreshedAtMs: now
  }, query)
  return { ok: true }
})
