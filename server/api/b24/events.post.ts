import { dbEnabled, query } from '../../db/client'
import { extractEvent, parseBracketForm } from '~/utils/b24Events'
import { decideB24Event } from '../../utils/b24EventsHandler'
import { deletePortal, getApplicationToken, saveToken } from '../../utils/tokenStore'
import { purgePortalFiles } from '../../utils/nodeFileIO'
import { encryptSecret } from '../../utils/secretCrypto'
import { verifyInstallToken } from '../../utils/verifyInstallToken'
import { rawOauthRefresh, verifyInstallMember, type RefreshedGrant } from '../../utils/verifyInstallMember'
import { normaliseHost, type FetchFn } from '../../utils/b24Rest'
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

  // #162: BIND the client-supplied member_id to the OAuth grant. verifyInstallToken above proves
  // control of the DOMAIN but not of member_id, so a forged install (a victim's member_id + a
  // valid token from the attacker's own portal) would poison the victim's member_id. We refresh
  // the delivered refresh_token — the token endpoint returns the AUTHORITATIVE member_id, which
  // must equal the claimed one. Refresh ROTATES the token, so on success we store the returned
  // grant (not the delivered creds). Gated on OAuth creds: without them we can't refresh at all
  // (crm-sync/keep-alive are dead too), so it degrades to the prior domain-only check.
  const clientId = process.env.B24_CLIENT_ID ?? ''
  const clientSecret = process.env.B24_CLIENT_SECRET ?? ''
  let grant: RefreshedGrant | undefined
  if (decision.verifyAccessToken && decision.action === 'register' && clientId && clientSecret) {
    const bound = await verifyInstallMember(ev.memberId, String(auth.refresh_token ?? ''), {
      refresh: rawOauthRefresh(globalThis.fetch as unknown as FetchFn),
      clientId,
      clientSecret
    })
    if (!bound.ok) {
      setResponseStatus(event, bound.status ?? 403)
      return { ok: false, error: 'member verification failed' }
    }
    grant = bound.grant
    // ACCEPTED window (low-sev): the refresh above ROTATED the grant at B24, so the delivered
    // refresh_token is now spent. If persistence below dies AFTER the refresh returned but BEFORE
    // the rotated grant is durably stored (a crash, or a sync-fallback DB throw), we hold no valid
    // creds. B24 doesn't retry online events → recovery is a reinstall (fresh grant, re-runs this
    // bind). The pre-existing verifyInstallToken path already had the "500 → stored nothing" window;
    // rotation only makes the delivered token unusable, which the reinstall replaces anyway.
  }

  // Build the verified packet. Refresh is encrypted HERE — plaintext never reaches Redis. When the
  // member_id bind ran, store the ROTATED grant (the delivered refresh_token is now spent).
  const refresh = grant?.refreshToken ?? String(auth.refresh_token ?? '')
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
          accessToken: grant?.accessToken ?? String(auth.access_token ?? ''),
          refreshTokenEnc: refresh ? encryptSecret(refresh, process.env.B24_TOKEN_ENC_KEY ?? '') : '',
          clientEndpoint: grant?.clientEndpoint || String(auth.client_endpoint ?? ''),
          expiresIn: grant?.expiresIn ?? Number(auth.expires_in ?? 3600),
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
