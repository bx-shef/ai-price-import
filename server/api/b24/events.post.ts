import { dbEnabled, query } from '../../db/client'
import { extractEvent, parseBracketForm } from '~/utils/b24Events'
import { decideB24Event } from '../../utils/b24EventsHandler'
import { deletePortal, getApplicationToken, saveToken } from '../../utils/tokenStore'
import { purgePortalFiles } from '../../utils/nodeFileIO'
import { encryptSecret } from '../../utils/secretCrypto'
import { verifyInstallToken } from '../../utils/verifyInstallToken'
import { normaliseHost } from '../../utils/b24Rest'
import { enqueueEvent } from '../../queue/producers'
import { queueEnabled } from '../../queue/connection'
import { eventJobToSaveInput, type EventJob } from '../../queue/topology'

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
      String(auth.access_token ?? '')
    )
    if (!verdict.ok) {
      setResponseStatus(event, verdict.status ?? 403)
      return { ok: false, error: 'install verification failed' }
    }
  }

  // Build the verified packet. Refresh is encrypted HERE — plaintext never reaches Redis.
  // KNOWN LIMITATION (low-sev, tracked): verifyInstallToken proves control of ev.domain,
  // but we store under the client-supplied ev.memberId without binding member_id↔domain
  // (targeted install-poisoning DoS; no hijack/data-theft). Full fix = authenticate
  // member_id from the OAuth token exchange. Deferred — not a deploy blocker.
  const refresh = String(auth.refresh_token ?? '')
  const job: EventJob = {
    memberId: ev.memberId,
    event: ev.event,
    // Normalised (bare lower-case host) so the frame-auth lookup (resolveFrameMember,
    // also normalised) matches regardless of case/scheme differences.
    domain: normaliseHost(ev.domain || String(auth.domain ?? '')),
    ts: ev.ts,
    applicationToken: ev.applicationToken,
    ...(decision.action === 'register'
      ? {
          accessToken: String(auth.access_token ?? ''),
          refreshTokenEnc: refresh ? encryptSecret(refresh, process.env.B24_TOKEN_ENC_KEY ?? '') : '',
          clientEndpoint: String(auth.client_endpoint ?? ''),
          expiresIn: Number(auth.expires_in ?? 3600),
          issuedAtMs: Date.now()
        }
      : {})
  }

  // Prefer the queue — the CONSUMER (single-instance b24-events worker) is the single
  // writer of portal_tokens. B24 does NOT retry online events, so if Redis is unavailable
  // (or the enqueue throws) we MUST NOT drop the event: fall back to a synchronous write.
  if (queueEnabled()) {
    try {
      await enqueueEvent(job, ev.ts)
      return { ok: true, queued: true }
    } catch (e) {
      console.error('[events] enqueue failed — applying synchronously:', e instanceof Error ? e.message : e)
    }
  }
  const saved = await applyEventSync(job)
  // register refused ⇒ stale install after a newer uninstall (tombstone): don't resurrect.
  if (saved === false) return { ok: true, skipped: 'stale-install-after-uninstall' }
  return { ok: true }
})

/** Synchronous fallback writer (no Redis / enqueue failed) — the SAME token store the
 * consumer uses (server/queue/liveDeps.liveEventDeps), so the write is identical; only the
 * transport differs. Returns the register verdict (false = refused by the tombstone guard). */
async function applyEventSync(job: EventJob): Promise<boolean | undefined> {
  if (job.event === 'ONAPPUNINSTALL') {
    await deletePortal(job.memberId, query, job.ts) // DB rows + tombstone
    await purgePortalFiles(job.memberId) // on-disk bytes (best-effort)
    return undefined
  }
  if (job.event === 'ONAPPINSTALL') {
    return await saveToken(eventJobToSaveInput(job), query, job.ts)
  }
  return undefined
}
