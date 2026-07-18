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
import type { AuthData, B24OAuthParams, B24OAuthSecret, CallbackRefreshAuth, CustomRefreshAuth } from '@bitrix24/b24jssdk'
import type { RestCall } from './b24Rest'
import { B24RestError, REST_TIMEOUT_MS, isSafeB24Domain } from './b24Rest'
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
  /** Override the OAuth refresh with a custom handler. A BARE-token client (frame/install —
   *  no server-side refresh token) sets this to hard-reject instead of POSTing an empty
   *  refresh_token to the OAuth server (see makeBareTokenSdkCall). */
  setCustomRefreshAuth: (cb: CustomRefreshAuth) => void
  /** Auth manager — `refreshAuth()` forces a PROACTIVE token refresh through the SDK (POST to
   *  the OAuth server), firing the setCallbackRefreshAuth callback. Used by sdkRefreshTransport. */
  auth: { refreshAuth: () => Promise<AuthData | false> }
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

/** DISABLE the SDK's in-client retry on a per-portal client (#123, live-tested via
 *  `pnpm loadtest:123`). Keep the default leaky-bucket (drainRate 2 / burst 50 — 0
 *  QUERY_LIMIT_EXCEEDED even at 10× scale-out), but `maxRetries:1` = one attempt, no retry
 *  (`retryOnNetworkError:false` belt-and-braces): a crm-sync job issues NON-IDEMPOTENT creates
 *  (crm.item.add / crm.product.add), and ANY in-SDK retry — after a client network timeout OR a
 *  server 504 (the request may have already COMMITTED) — would silently duplicate the entity
 *  (Bitrix doesn't enforce originId/xmlId uniqueness). We let the whole BullMQ job fail + retry,
 *  where creates are idempotent (findExisting-before-create). STILL ON (independent of the retry
 *  loop — live-verified: limitHits fire with maxRetries:1): the proactive rate-limit throttle, the
 *  operating-limit adaptive backoff, and the reactive OAuth token-refresh. Shared by the OAuth and
 *  bare-token clients (a bare token wants fail-fast too: one attempt → reactive-reject, no retry). */
function disableSdkRetry(client: OAuthCallClient): void {
  client.setRestrictionManagerParams({ ...ParamsFactory.getDefault(), maxRetries: 1, retryOnNetworkError: false })
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
  disableSdkRetry(client)
  return { call: makeSdkRestCall(client), list: makeSdkListCall(client) }
}

// ── Bare-token transport (frame / install access token) ──────────────────────────────────
// A frame/install access token is USER-scoped and short-lived: the server holds NO refresh
// token or client secret bound to it, so it cannot be renewed here. We still route these calls
// through the SDK (unified transport: rate-limiter + 30s timeout + drift guard) — but a bare
// token can't refresh, so any auth error means the token is REJECTED, not "expired, refresh me".

/** Message thrown when a bare token hits an auth error. Carries `invalid_token` so
 *  b24Rest.isAuthRejection classifies it as a token rejection (→401/403), not a transport
 *  error (→502/503) — preserving the frame/install verification semantics. */
export const BARE_TOKEN_REJECTED = 'invalid_token: bare frame/install token cannot be refreshed'

/** Far-future expiry (2100) so the SDK treats a bare token as perpetually fresh and never
 *  PROACTIVELY refreshes it. If the token is actually invalid/expired the REST call still gets
 *  an auth error → reactive refresh → our custom hook throws BARE_TOKEN_REJECTED. */
const BARE_TOKEN_EXPIRES_S = 4_102_444_800

/** SDK `RestCall` for a BARE access token (frame/install) — the drop-in replacement for
 *  b24Rest.makeRestCall on the frame-token paths (resolveFrameMember / verifyInstallToken /
 *  app.option I/O). The wire call is identical (the token rides as `auth`), but the transport is
 *  the SDK's, and a bare token hard-rejects on any auth error instead of POSTing an empty
 *  refresh_token to the OAuth server. No client creds needed (the custom refresh never POSTs). */
export function makeBareTokenSdkCall(domain: string, accessToken: string): RestCall {
  const d = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim().toLowerCase()
  const params: B24OAuthParams = {
    applicationToken: '',
    userId: 0,
    memberId: '',
    accessToken,
    refreshToken: '',
    expires: BARE_TOKEN_EXPIRES_S, // absolute epoch (s) — getAuthData() gates freshness on this
    expiresIn: 0, // duration, never consumed for a bare token (no proactive refresh)
    scope: '',
    domain: d,
    clientEndpoint: `https://${d}/rest/`,
    serverEndpoint: B24_SERVER_ENDPOINT,
    status: 'L'
  }
  // Typing the instance as OAuthCallClient is the drift guard (see file header).
  const client: OAuthCallClient = new B24OAuth(params, { clientId: '', clientSecret: '' })
  // Bare token has no refresh path: any auth error is a hard rejection, not "refresh me".
  client.setCustomRefreshAuth(() => Promise.reject(new Error(BARE_TOKEN_REJECTED)))
  disableSdkRetry(client)
  const sdkCall = makeSdkRestCall(client)
  return (method, callParams) => {
    // SSRF guard: `domain` is client-supplied (X-B24-Domain / install event) — only ever call
    // Bitrix24 hosts so a forged domain can't exfiltrate the token to an attacker host. Thrown
    // at call time (inside the caller's try/catch), same as the old b24Rest.restUrl guard; not
    // an auth rejection → transport-class (verify paths → 502/503), never trusts the forgery.
    if (!isSafeB24Domain(d)) return Promise.reject(new B24RestError('UNSAFE_DOMAIN', `refusing REST to ${d}`))
    return sdkCall(method, callParams)
  }
}

// ── OAuth refresh transport (keep-alive cron + operator reauth) ───────────────────────────
// Force-refresh a portal's OAuth token THROUGH the SDK (`refreshAuth`) instead of a hand-rolled
// POST. Same effect (POST grant_type=refresh_token to the OAuth server) but: secrets ride in the
// POST body (the old code put them in the URL query → access-log leak), and it uses the SDK's
// typed RefreshTokenError. Wired as EnsureDeps.refreshTransport, so ensureFreshToken keeps its
// per-portal advisory lock + re-read + UPDATE-only persist (#35) unchanged.

/** Race a promise against a timeout, clearing the timer on either settle path (no dangling
 *  timer on the fast path). The SDK's refresh axios has NO timeout, but the refresh runs inside
 *  ensureFreshToken's advisory lock holding a pooled connection — a hung OAuth server must not
 *  pin the lock. On timeout we reject (ensureFreshToken then rolls back + releases the connection).
 *  KNOWN EDGE (accepted): the orphaned axios request is NOT cancelled — if the OAuth server was
 *  merely slow (responds past `ms`) it may have rotated the refresh token server-side while we
 *  rolled back, leaving the stored refresh stale; recovery is the operator reauth button (#132).
 *  This is inherent to a refresh crossing the timeout and is rare (the token endpoint answers in
 *  well under a second); the lock-safety it buys is worth the trade. Exported for unit test. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`b24 oauth refresh: no response within ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

/** Map the SDK's refreshed params/authData → the raw token-response shape parseTokenResponse
 *  consumes. `captured` (from the setCallbackRefreshAuth callback) carries the full updated
 *  fields (clientEndpoint/scope/status); `authData` is the refreshAuth return (fallback). Pure.
 *  access_token/refresh_token are left UNDEFINED when neither source has them (never coerced to
 *  '') — a malformed 200 (no token, no error) must still fail parseTokenResponse's string guard
 *  and THROW, not persist blank credentials over a live portal (fail-closed, as the old raw path). */
export function rawTokenFromRefresh(captured: B24OAuthParams | undefined, authData: AuthData | false): Record<string, unknown> {
  const a = authData || undefined
  return {
    access_token: captured?.accessToken ?? a?.access_token,
    refresh_token: captured?.refreshToken ?? a?.refresh_token,
    expires_in: captured?.expiresIn ?? a?.expires_in,
    expires: captured?.expires ?? a?.expires,
    client_endpoint: captured?.clientEndpoint,
    server_endpoint: captured?.serverEndpoint,
    scope: captured?.scope,
    status: captured?.status,
    member_id: captured?.memberId ?? a?.member_id ?? ''
  }
}

/** Build an EnsureDeps.refreshTransport that refreshes THROUGH the SDK. Receives the refresh
 *  params (client_id/client_secret/refresh_token, built by buildRefreshParams) and returns the
 *  raw token JSON. The transient B24OAuth's domain is a placeholder — refreshAuth POSTs to the
 *  OAuth server (serverEndpoint), never the portal domain, and ensureFreshToken keeps the real
 *  stored portal domain. Bounded by `timeoutMs` (default REST_TIMEOUT_MS). */
export function sdkRefreshTransport(opts: { timeoutMs?: number } = {}): (params: Record<string, string>) => Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? REST_TIMEOUT_MS
  return async (params) => {
    const oauthParams: B24OAuthParams = {
      applicationToken: '',
      userId: 0,
      memberId: '',
      accessToken: '',
      refreshToken: params.refresh_token ?? '',
      expires: 0,
      expiresIn: 0,
      scope: '',
      domain: 'oauth.bitrix.info',
      clientEndpoint: 'https://oauth.bitrix.info/rest/',
      serverEndpoint: B24_SERVER_ENDPOINT,
      status: 'L'
    }
    const client: OAuthCallClient = new B24OAuth(oauthParams, { clientId: params.client_id ?? '', clientSecret: params.client_secret ?? '' })
    let captured: B24OAuthParams | undefined
    // Capture the refreshed params (fuller than the refreshAuth return); persistence stays with
    // ensureFreshToken (this callback only records — it must NOT double-write).
    client.setCallbackRefreshAuth(async ({ b24OAuthParams }) => {
      captured = b24OAuthParams
    })
    const authData = await withTimeout(client.auth.refreshAuth(), timeoutMs)
    return rawTokenFromRefresh(captured, authData)
  }
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

// ── Per-portal transport memoization (#123 / #163) ────────────────────────────────────────
// Without this, liveDeps.restResolver built a FRESH B24OAuth on EVERY resolver call, and a
// crm-sync job calls the resolver ~9 times (each `need()` in liveCrmSyncDeps) — 9 clients per
// job, i.e. 9 leaky-bucket rate-limiter buckets + 9 token loads, defeating the documented
// "one client per job" invariant and raising the QUERY_LIMIT_EXCEEDED risk at scale-out.
// createPortalSdkResolver memoizes ONE client per portal so all those calls share a single
// bucket + a single token load. Ported from bx-shef/client-bank-alfa-by (portalSdkResolver.ts).

/** Per-portal SDK-transport TTL (#123 / #163). One memoized `B24OAuth` per member lives this
 *  long: every resolver call within a crm-sync job (and across close-together jobs for the same
 *  portal) then shares one rate-limiter bucket + one token load. Kept SHORT so an external
 *  refresh-token rotation (a peer replica or the keep-alive cron #175) can't wedge a stale client
 *  for long — and evict-on-error heals it immediately on the first failed call regardless. */
export const SDK_CLIENT_TTL_MS = 60_000

/** A memoizing portal-transport resolver: `(memberId) → SdkTransport | null`, plus `evict`. */
export interface PortalSdkResolver {
  (memberId: string): Promise<SdkTransport | null>
  /** Drop the cached client for a portal (e.g. on uninstall, or to force a rebuild). */
  evict: (memberId: string) => void
  /** Live count of cached clients — for observability / tests (bounds the working set). */
  size: () => number
}

/** Build a resolver that memoizes the per-portal `SdkTransport` so ONE `B24OAuth` (one
 *  leaky-bucket limiter, one token load) serves every call for a portal within the TTL — the
 *  "one client per job" invariant (#123). Two valves keep this short-lived cache safe against an
 *  EXTERNAL refresh-token rotation (which would leave this client's in-memory refresh token stale
 *  → invalid_grant forever if cached naively):
 *    - EVICT-ON-ERROR: any failed call/list drops its cached entry, so the NEXT resolve rebuilds
 *      from the CURRENT DB token at once. Identity-checked so a late error from an already-replaced
 *      client can't evict the fresh one.
 *    - TTL backstop: even a client that never errors is rebuilt after `ttlMs`.
 *  `build` is injected (defaults to a makePortalSdkCall binding at the call site) so the resolver
 *  is unit-testable with a fake transport and a controllable clock. This is NOT a naive
 *  process-lifetime cache — the TTL + evict make it self-healing after a rotation. */
export function createPortalSdkResolver(
  build: (memberId: string) => Promise<SdkTransport | null>,
  now: () => number = Date.now,
  ttlMs: number = SDK_CLIENT_TTL_MS
): PortalSdkResolver {
  interface Entry { transport: SdkTransport, builtAt: number }
  const cache = new Map<string, Entry>()

  const ensure = async (memberId: string): Promise<SdkTransport | null> => {
    const cached = cache.get(memberId)
    if (cached && now() - cached.builtAt < ttlMs) return cached.transport
    // TTL lapsed / first use: drop any stale entry BEFORE rebuilding so a build failure never
    // leaves an expired client resolvable (and evict-by-identity below stays unambiguous).
    if (cached) cache.delete(memberId)
    const raw = await build(memberId)
    if (!raw) return null
    const evictSelf = (): void => {
      // Identity-checked: only drop THIS entry, never a fresher client that already replaced it.
      if (cache.get(memberId) === entry) cache.delete(memberId)
    }
    const transport: SdkTransport = {
      call: async (method, params) => {
        try {
          return await raw.call(method, params)
        } catch (e) {
          evictSelf()
          throw e
        }
      },
      list: async (method, params, opts) => {
        try {
          return await raw.list(method, params, opts)
        } catch (e) {
          evictSelf()
          throw e
        }
      }
    }
    const entry: Entry = { transport, builtAt: now() }
    // Bound the cache to the ACTIVE working set: sweep TTL-lapsed entries on every insert. A
    // portal touched once then idle would otherwise linger forever (holding a live B24OAuth +
    // decrypted refresh token) — lazy per-key TTL only reclaims a key that's re-resolved. O(n)
    // per build, n = portals seen within one TTL window. `evict()` (uninstall/cutover) is the
    // only OTHER reclaim path; this makes long-idle portals self-reclaim regardless.
    const cutoff = now() - ttlMs
    for (const [k, e] of cache) {
      if (e.builtAt <= cutoff) cache.delete(k)
    }
    cache.set(memberId, entry)
    return transport
  }

  const resolver = ((memberId: string) => ensure(memberId)) as PortalSdkResolver
  resolver.evict = (memberId: string): void => {
    cache.delete(memberId)
  }
  resolver.size = (): number => cache.size
  return resolver
}
