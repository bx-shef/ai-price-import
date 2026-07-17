// Pure Bitrix24 REST helpers + the transport contract. All B24 REST goes through the SDK
// (@bitrix24/b24jssdk, server/utils/b24Sdk.ts) — this module keeps the shared TYPE (`RestCall`),
// the SSRF host guard (`isSafeB24Domain`, reused by the SDK bare-token transport + frameAuth),
// and the typed error. No ambient I/O here; the raw-fetch caller + its envelope unwrap were
// retired when the transport moved to the SDK (which unwraps `result` itself).

/** Minimal fetch-like signature (still used for the non-B24 GitHub POST — feedbackGithub). */
export type FetchFn = (url: string, init?: { method?: string, headers?: Record<string, string>, body?: string, signal?: AbortSignal }) => Promise<{ ok: boolean, status: number, json: () => Promise<unknown> }>

/** A bound REST caller for one portal (domain + access token). The SDK transport
 *  (b24Sdk.makeSdkRestCall / makeBareTokenSdkCall) and every lookup helper share this shape. */
export type RestCall = (method: string, params?: Record<string, unknown>) => Promise<unknown>

/** Default per-call REST timeout (ms). A hung portal must not pin a worker/request forever
 *  (used as the SDK refresh timeout bound — sdkRefreshTransport). */
export const REST_TIMEOUT_MS = 15_000

/** Normalise a portal domain to a bare host. */
export function normaliseHost(domain: string): string {
  return domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim().toLowerCase()
}

/** SSRF guard: only allow Bitrix24 cloud hosts (the portal domain comes from the install event). */
export function isSafeB24Domain(domain: string): boolean {
  const host = normaliseHost(domain)
  if (!host || host.includes('@') || host.includes(':')) return false
  return /^([a-z0-9-]+\.)+bitrix24\.[a-z]{2,}$/.test(host) || host === 'oauth.bitrix24.tech'
}

/** Typed B24 REST error carrying the machine-readable error code + HTTP status,
 * so callers can detect `expired_token`/`invalid_token` and retry after refresh. */
export class B24RestError extends Error {
  constructor(readonly code: string, readonly description: string, readonly status = 0) {
    super(`b24 rest: ${code}${description ? `: ${description}` : ''}`)
    this.name = 'B24RestError'
  }
}

/** True when a REST error means the auth token was REJECTED (forbidden) rather than a
 * transport/network failure — lets callers tell "unauthorised" from "retry later". */
export function isAuthRejection(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return /invalid_token|expired_token|wrong_auth|no_auth|unauthorized|authoriz|invalid_grant|access denied|insufficient_scope|\b401\b|\b403\b/.test(msg)
}
