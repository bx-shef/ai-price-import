// Adapter: a per-portal Bitrix24 OAuth client (@bitrix24/b24jssdk) exposed as our
// `RestCall`. The SDK ships a RestrictionManager — a PER-INSTANCE leaky-bucket rate
// limiter (default ~2 req/s) with adaptive delay and retry-backoff on
// QUERY_LIMIT_EXCEEDED / 429 / 5xx, enabled by default. Building ONE `B24OAuth` per
// portal per crm-sync job therefore gives:
//   - per-portal rate limiting (B24 limits are per-portal — one big portal can't starve
//     the others, each portal has its own bucket), and
//   - bind-`RestCall`-once (token resolved once for the job, not per op).
// The caller MUST build this per crm-sync job (NOT cache it for the worker process): the
// client holds the refresh token in memory, so a process-lifetime cache would wedge on a
// stale token after a peer replica / keep-alive cron rotates it. See liveDeps.restResolver.
// Token refresh is automatic; the SDK's `setCallbackRefreshAuth` hands us the new token so
// we persist it (UPDATE-only, via updateTokensOnRefresh — won't resurrect a purged portal).
//
// Server-only module — uses the SDK the normal way (value import + real `new B24OAuth`).
// The pure mappers and `makeSdkRestCall` (STRUCTURAL client) stay unit-testable with a fake.
// Typing the constructed client as `OAuthCallClient` is the compile-time drift guard: if a
// @bitrix24/b24jssdk bump renames/removes `actions`/`setCallbackRefreshAuth`, typecheck fails
// at that assignment rather than only on a live smoke-test.

import { B24OAuth, ParamsFactory } from '@bitrix24/b24jssdk'
import type { B24OAuthParams, B24OAuthSecret, CallbackRefreshAuth } from '@bitrix24/b24jssdk'
import type { RestCall } from './b24Rest'
import type { PortalToken, QueryFn, SaveTokenInput } from './tokenStore'
import { getToken, updateTokensOnRefresh } from './tokenStore'
import { decryptSecret, encryptSecret } from './secretCrypto'

/** B24 OAuth server endpoint (constant — the SDK refreshes tokens against it). */
const B24_SERVER_ENDPOINT = 'https://oauth.bitrix.info/rest/'

/** The slice of a B24 OAuth client this adapter uses — structural so tests inject a fake
 *  and the real `B24OAuth` satisfies it (checked where the client is constructed). */
export interface OAuthCallClient {
  actions: {
    v2: {
      call: { make: (o: { method: string, params?: Record<string, unknown> }) => Promise<SdkAjaxResult> }
      // Full-list fetch: the SDK pages through EVERY row (keyset pagination by `idKey`,
      // default 'ID') and hands back the concatenated array via getData(). `customKeyForResult`
      // names the grouped result key (e.g. `productProperties`). We use this instead of a
      // hand-rolled pager for list reads on the OAuth transport.
      callList: { make: (o: { method: string, params?: Record<string, unknown>, idKey?: string, customKeyForResult?: string }) => Promise<SdkListResult> }
    }
  }
  setCallbackRefreshAuth: (cb: CallbackRefreshAuth) => void
  /** Tune the built-in RestrictionManager (rate-limit + retry). We use it to turn OFF
   *  network-error retry on this per-portal client (#123) — see makePortalSdkCall. */
  setRestrictionManagerParams: (params: Record<string, unknown>) => void
}

/** The bits of the SDK's `AjaxResult` we read. `getData()` returns the full REST envelope
 *  (`{ result, time, … }`); our RestCall contract returns the UNWRAPPED `result`. */
export interface SdkAjaxResult {
  isSuccess: boolean
  getData: () => Record<string, unknown> | null | undefined
  getErrorMessages: () => string[]
}

/** The SDK's `callList.make` Result — `getData()` is the ALREADY-collected row array. */
export interface SdkListResult {
  getData: () => unknown
}

/** Fetch EVERY row of a B24 list method — the SDK handles pagination. `idKey` overrides
 *  the keyset cursor field (default 'ID'; e.g. 'id' for catalog.*); `listKey` names the
 *  grouped result key (e.g. 'productProperties') for methods that wrap rows in an object. */
export type SdkListCall = (method: string, params?: Record<string, unknown>, opts?: { idKey?: string, listKey?: string }) => Promise<unknown[]>

/** A portal-bound SDK transport: single-call `RestCall` PLUS a full-list `list` fetcher,
 *  both backed by the same per-portal `B24OAuth` (one rate-limiter bucket for the job). */
export interface SdkTransport {
  call: RestCall
  list: SdkListCall
}

/** Map our stored `PortalToken` → the SDK's `B24OAuthParams`. The refresh token is
 *  DECRYPTED here (we store it encrypted at rest). Pure (nowMs + decrypt injected).
 *  `expiresAt` is derived: issuedAtMs + expiresIn*1000. */
export function oauthParamsFromToken(token: PortalToken, opts: { nowMs: number, decrypt: (enc: string) => string, scope?: string }): B24OAuthParams {
  const domain = token.domain.trim()
  const expiresAtMs = token.issuedAtMs + token.expiresIn * 1000
  return {
    applicationToken: token.applicationToken,
    userId: 0, // used only for the SDK's admin-init, not REST calls
    memberId: token.memberId,
    accessToken: token.accessToken,
    refreshToken: token.refreshTokenEnc ? opts.decrypt(token.refreshTokenEnc) : '',
    expires: Math.floor(expiresAtMs / 1000),
    expiresIn: Math.max(0, Math.floor((expiresAtMs - opts.nowMs) / 1000)),
    scope: opts.scope ?? '',
    domain,
    clientEndpoint: `https://${domain}/rest/`,
    serverEndpoint: B24_SERVER_ENDPOINT,
    status: 'L' // EnumAppStatus.Local — not consulted for REST calls
  }
}

/** Map the SDK's refreshed `B24OAuthParams` → our `SaveTokenInput` (refresh ENCRYPTED for
 *  at-rest). issuedAtMs/refreshedAtMs = nowMs. application_token is write-once in the store. */
export function saveInputFromOAuthParams(p: B24OAuthParams, opts: { nowMs: number, encrypt: (plain: string) => string }): SaveTokenInput {
  return {
    memberId: p.memberId,
    domain: p.domain,
    clientEndpoint: p.clientEndpoint,
    accessToken: p.accessToken,
    refreshTokenEnc: p.refreshToken ? opts.encrypt(p.refreshToken) : '',
    applicationToken: p.applicationToken,
    expiresIn: p.expiresIn,
    issuedAtMs: opts.nowMs,
    refreshedAtMs: opts.nowMs
  }
}

/** Build the refresh callback the SDK invokes after it renews the access token —
 *  persists the fresh (re-encrypted) token so the next job/instance starts current. */
export function buildRefreshPersist(save: (input: SaveTokenInput) => Promise<void>, opts: { now: () => number, encrypt: (plain: string) => string }): CallbackRefreshAuth {
  return async ({ b24OAuthParams }) => {
    await save(saveInputFromOAuthParams(b24OAuthParams, { nowMs: opts.now(), encrypt: opts.encrypt }))
  }
}

/** Wrap a B24 OAuth client as our `RestCall`: run the (rate-limited, auto-retried) call and
 *  return the UNWRAPPED `result` (ai-price-import's contract — callers cast it directly, e.g.
 *  `crm.product.list` → array). Throws the SDK's error messages so a failed call fails the
 *  crm-sync job for a clean retry, same as the hand-rolled `makeRestCall`. */
export function makeSdkRestCall(client: OAuthCallClient): RestCall {
  return async (method, params) => {
    const res = await client.actions.v2.call.make({ method, params })
    if (!res.isSuccess) throw new Error(res.getErrorMessages().join('; ') || `B24 REST ${method} failed`)
    const data = (res.getData() ?? {}) as { result?: unknown }
    return data.result
  }
}

/** Wrap a B24 OAuth client's `callList.make` as our `SdkListCall`: page through ALL rows
 *  (the SDK's built-in pagination) and return the flat array. `opts.idKey`/`opts.listKey`
 *  map to the SDK's `idKey`/`customKeyForResult` (grouped methods like
 *  catalog.productProperty.list need both). Non-array data (empty portal) → `[]`. */
export function makeSdkListCall(client: OAuthCallClient): SdkListCall {
  return async (method, params, opts) => {
    const res = await client.actions.v2.callList.make({
      method,
      params,
      ...(opts?.idKey ? { idKey: opts.idKey } : {}),
      ...(opts?.listKey ? { customKeyForResult: opts.listKey } : {})
    })
    const data = res.getData()
    return Array.isArray(data) ? data : []
  }
}

/** I/O the portal-bound factory needs, injected for testability. The SDK client itself is
 *  NOT injected — this module owns `new B24OAuth(...)`; only its inputs come from the caller. */
export interface SdkPortalDeps {
  loadToken: (memberId: string) => Promise<PortalToken | null>
  saveToken: (input: SaveTokenInput) => Promise<void>
  creds: B24OAuthSecret
  now: () => number
  decrypt: (enc: string) => string
  encrypt: (plain: string) => string
  scope?: string
}

/** Build the per-portal transport (single-call `.call` + full-list `.list`), backed by one
 *  `B24OAuth` instance (its own rate-limiter bucket) with refresh-persistence wired. `null`
 *  when the portal has no stored token. This is THE crm-sync portal transport (see
 *  liveDeps.restResolver).
 *  NB: the SDK refreshes REACTIVELY — one extra round-trip on the first call after
 *  access-token expiry; the daily keep-alive cron (#175) still proactively refreshes idle
 *  near-expiry portals via ensureFreshToken (advisory lock, #35). */
export async function makePortalSdkCall(memberId: string, deps: SdkPortalDeps): Promise<SdkTransport | null> {
  const token = await deps.loadToken(memberId)
  if (!token) return null
  // Typing the instance as OAuthCallClient is the drift guard (see file header).
  const client: OAuthCallClient = new B24OAuth(
    oauthParamsFromToken(token, { nowMs: deps.now(), decrypt: deps.decrypt, scope: deps.scope }),
    deps.creds
  )
  client.setCallbackRefreshAuth(buildRefreshPersist(deps.saveToken, { now: deps.now, encrypt: deps.encrypt }))
  // Calibration (#123, live-tested via `pnpm loadtest:123`): the default leaky-bucket
  // (drainRate 2 / burst 50) holds — 0 QUERY_LIMIT_EXCEEDED even at 10× scale-out — so we keep
  // the rate-limit params. We DISABLE in-SDK retry entirely (maxRetries:1 = one attempt, no
  // retry; retryOnNetworkError:false as belt-and-braces): a crm-sync job issues NON-IDEMPOTENT
  // creates (crm.item.add / crm.product.add), and ANY in-SDK retry of one — after a client-side
  // network timeout OR a server-returned 504 (the request may have already COMMITTED) — would
  // silently duplicate the entity, since Bitrix does not enforce originId/xmlId uniqueness.
  // Instead we let the whole BullMQ job fail + retry, where creates are idempotent
  // (findExisting-before-create via the #135 marker; findProduct before crm.product.add).
  // What STAYS on (all independent of the retry loop — live-verified: limitHits still fire with
  // maxRetries:1): the PROACTIVE rate-limit throttle (waits before send), the operating-limit
  // adaptive backoff, and the reactive OAuth token-refresh (its own path, abstract-http _isAuthError).
  // Trade: a rare QUERY_LIMIT_EXCEEDED/5xx now costs a job-level retry instead of an in-SDK one —
  // acceptable for this low-concurrency design, and the proactive limiter prevents QLE anyway.
  client.setRestrictionManagerParams({ ...ParamsFactory.getDefault(), maxRetries: 1, retryOnNetworkError: false })
  return { call: makeSdkRestCall(client), list: makeSdkListCall(client) }
}

/** Live env/infra a portal-bound SDK transport needs (shared by the crm-sync worker and
 *  the in-portal API routes so the wiring lives in ONE place). */
export interface SdkInfra {
  query: QueryFn
  clientId: string
  clientSecret: string
  /** AES key (base64) for refresh-token decrypt/encrypt at rest. */
  encKey: string
  now: () => number
}

/** Bind `SdkPortalDeps` (token load/save + crypto + creds) to the live stores/env. Used by
 *  liveDeps.restResolver (crm-sync) and the frame-token routes that read via the portal's
 *  OAuth token (e.g. the catalog-property picker). */
export function sdkPortalDeps(infra: SdkInfra): SdkPortalDeps {
  return {
    loadToken: m => getToken(m, infra.query),
    saveToken: input => updateTokensOnRefresh(input, infra.query),
    creds: { clientId: infra.clientId, clientSecret: infra.clientSecret },
    now: infra.now,
    decrypt: enc => (enc ? decryptSecret(enc, infra.encKey) : ''),
    encrypt: plain => encryptSecret(plain, infra.encKey)
  }
}
