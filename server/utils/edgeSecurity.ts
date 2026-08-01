// Compensating edge protections for the "black hole" (Bitrix24 Vibecode) deploy target, where the
// app runs as a single Nitro process directly internet-facing with NO nginx in front — so the CSP /
// security headers / HSTS that nginx.conf normally provides, and the login `limit_req`, are absent.
// These are gated behind APP_EDGE_SECURITY so they are a NO-OP behind nginx (default), avoiding a
// double CSP header (multiple CSP headers intersect restrictively) or a login throttle that would
// bucket every client under the shared proxy IP. Pure + DI on env → unit-tested. See docs/PROCESS.md §12.2.

import { clientKey } from './demoRateLimit'

/** True only when this process is directly internet-facing (no nginx) and must self-apply edge controls. */
export function edgeSecurityEnabled(env: Record<string, string | undefined>): boolean {
  const v = (env.APP_EDGE_SECURITY ?? '').trim().toLowerCase()
  return v === '1' || v === 'true'
}

/**
 * Escape hatch for the no-nginx target: set APP_EDGE_TRUST_XFF=1 ONLY after live-verifying that the
 * platform ingress (e.g. the Bitrix24 Vibecode tunnel) is a trusted proxy that APPENDS the real client
 * as the last X-Forwarded-For hop. Then per-IP limits key on that hop instead of `socket.remoteAddress`
 * (which, behind such a tunnel, is a single shared gateway IP → all clients collapse into one bucket →
 * demo/login lockout). Default OFF is bypass-safe: keying on the real TCP peer can't be spoofed, and the
 * worst case (shared peer) is a GLOBAL cap — still no cost-drain/brute-force, only reduced availability.
 */
export function edgeTrustXff(env: Record<string, string | undefined>): boolean {
  const v = (env.APP_EDGE_TRUST_XFF ?? '').trim().toLowerCase()
  return v === '1' || v === 'true'
}

/**
 * Per-IP rate-limit key that adapts to the deploy topology. Behind nginx (edge OFF) the proxy appends
 * the real peer as the LAST X-Forwarded-For hop, so `clientKey` trusts that. With NO nginx (edge ON) the
 * whole X-Forwarded-For is client-controlled and must be ignored — key on the real TCP peer only, so a
 * client can't rotate a spoofed header to dodge the limit — UNLESS `trustXff` says the tunnel is itself a
 * verified trusted proxy (then use its appended last hop). Used by the public demo + login throttles.
 */
export function rateLimitKey(edgeOn: boolean, trustXff: boolean, xff: string | undefined, remote: string | undefined): string {
  if (!edgeOn || trustXff) return ipBucket(clientKey(xff, remote))
  return ipBucket((remote ?? '').trim() || 'unknown')
}

/**
 * Collapse an IPv6 address to its /64 prefix before it becomes a rate-limit key. A single subscriber is
 * routinely handed a whole /64, so keying on the full address means 2^64 free buckets: one loop over
 * `curl --interface` lifts the login throttle AND the demo cost cap completely. nginx's
 * `$binary_remote_addr` has the same hole, so this is not a regression there — it is a cheap fix here.
 * IPv4 and anything unparseable pass through untouched (a v4 address IS the identity).
 * IPv4-mapped v6 (`::ffff:1.2.3.4`) keeps its full form on purpose — truncating it would merge
 * unrelated v4 clients into one bucket.
 */
export function ipBucket(key: string): string {
  const raw = key.trim()
  if (!raw.includes(':')) return raw || 'unknown' // v4 / hostname / 'unknown'
  if (raw.toLowerCase().includes('.')) return raw // IPv4-mapped — keep the whole address
  const zoneless = raw.split('%')[0] ?? raw
  const groups = expandV6(zoneless)
  return groups ? `${groups.slice(0, 4).join(':')}::/64` : raw
}

/** Expand an IPv6 address (incl. `::`) to its eight groups, or null when it does not parse. */
function expandV6(addr: string): string[] | null {
  const halves = addr.split('::')
  if (halves.length > 2) return null
  const head = (halves[0] ?? '').split(':').filter(Boolean)
  const tail = halves.length === 2 ? (halves[1] ?? '').split(':').filter(Boolean) : []
  const groups = halves.length === 2
    ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail]
    : head
  if (groups.length !== 8) return null
  return groups.map(g => (/^[0-9a-fA-F]{1,4}$/.test(g) ? g.toLowerCase().replace(/^0+(?=.)/, '') : null))
    .every(Boolean)
    ? groups.map(g => g.toLowerCase().replace(/^0+(?=.)/, ''))
    : null
}

// Kept byte-identical to nginx.conf so the two paths present the same policy (no drift): the strict
// page CSP and the relaxed, form-scoped CSP for the B24 CRM-form loader iframe (public/b24-form.html).
const PAGE_CSP
  = 'default-src \'self\'; img-src \'self\' data: https:; style-src \'self\' \'unsafe-inline\'; '
    + 'script-src \'self\' \'unsafe-inline\'; '
    + 'connect-src \'self\' https://*.bitrix24.com https://*.bitrix24.ru https://*.bitrix24.by https://*.bitrix24.eu https://*.bitrix24.kz; '
    + 'frame-ancestors \'self\' https://*.bitrix24.com https://*.bitrix24.ru https://*.bitrix24.by https://*.bitrix24.eu https://*.bitrix24.kz; '
    + 'base-uri \'self\'; object-src \'none\''

const FORM_CSP
  = 'default-src \'self\' https://*.bitrix24.by https://*.bitrix24.ru https://*.bitrix24.com https://*.bitrix24.kz https://*.bitrix24.tech; '
    + 'script-src \'self\' \'unsafe-inline\' \'unsafe-eval\' https://*.bitrix24.by https://*.bitrix24.ru https://*.bitrix24.com https://*.bitrix24.kz https://*.bitrix24.tech; '
    + 'style-src \'self\' \'unsafe-inline\' https://*.bitrix24.by https://*.bitrix24.ru https://*.bitrix24.com; '
    + 'img-src \'self\' data: https:; '
    + 'connect-src \'self\' https://*.bitrix24.by https://*.bitrix24.ru https://*.bitrix24.com https://*.bitrix24.kz https://*.bitrix24.tech; '
    + 'font-src \'self\' data: https:; '
    + 'frame-src https://*.bitrix24.by https://*.bitrix24.ru https://*.bitrix24.com https://*.bitrix24.kz; '
    + 'frame-ancestors \'self\'; base-uri \'self\';'

const HSTS = 'max-age=63072000; includeSubDomains'

/** The form loader needs the relaxed CSP; every other path gets the strict page CSP. */
export function contentSecurityPolicy(pathname: string): string {
  return pathname === '/b24-form.html' ? FORM_CSP : PAGE_CSP
}

/**
 * Security headers to attach to a response for `pathname`. Mirrors nginx.conf. HSTS is safe to send
 * even over plain HTTP (browsers ignore it there), and the Vibecode target serves HTTPS.
 */
export function buildSecurityHeaders(pathname: string): Record<string, string> {
  return {
    'Content-Security-Policy': contentSecurityPolicy(pathname),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Strict-Transport-Security': HSTS
  }
}

/** Strip query/hash so `/b24-form.html?x=1` still matches the form path. */
export function normalisePathname(path: string): string {
  const q = path.indexOf('?')
  const base = q === -1 ? path : path.slice(0, q)
  const h = base.indexOf('#')
  return h === -1 ? base : base.slice(0, h)
}

// Operator-login brute-force budget when edge security is on (no nginx limit_req to lean on):
// N attempts per window per client IP → 429. Deliberately generous for a human operator, strict for a bot.
export const LOGIN_MAX_ATTEMPTS = 10
export const LOGIN_WINDOW_MS = 15 * 60 * 1000

// Global request-body cap when edge security is on — mirrors nginx `client_max_body_size 25m` (the
// backstop that's absent without nginx). The largest legit body is the ~20 MB in-portal upload.
export const EDGE_MAX_BODY_BYTES = 25 * 1024 * 1024

/**
 * Body-size backstop for the no-nginx target (no nginx `client_max_body_size`). Returns the HTTP status
 * to reject with, or null (ok):
 *  - 413 when the declared Content-Length exceeds `max` (checked in BOTH topologies — defense in depth);
 *  - 411 when Content-Length is ABSENT and edge security is on — a chunked body with no declared length
 *    would otherwise buffer unbounded (OOM). Behind nginx (edgeOff) a missing length is left to nginx.
 * Apply on routes that buffer the whole body (multipart uploads). `contentLength` is the parsed header (0 if absent).
 */
export function bodySizeStatus(edgeOn: boolean, contentLength: number, max: number): 411 | 413 | null {
  const cl = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0
  if (cl > max) return 413
  if (edgeOn && cl === 0) return 411
  return null
}

/**
 * Edge body guard, applied by the middleware to every request that can CARRY a body when edge security
 * is on — the safe-by-default equivalent of nginx `client_max_body_size` for a process with no nginx.
 *
 * "Every request that can carry a body" is exact, not hand-waving: Nitro's public-assets handler runs
 * before the middleware and answers prerendered files, but it handles GET and HEAD ONLY — and those are
 * the methods that bring no body. A POST to a prerendered path falls through to the middleware and is
 * guarded (live-checked: `POST /app` with an over-cap Content-Length answers 413, same as
 * `POST /api/b24/events`). That asymmetry is exactly why the security HEADERS could not stay here — they
 * belong on the GET responses the static handler owns — while this guard can.
 *
 * Returns the status to reject with, or null:
 *  - 413 when the declared Content-Length exceeds `max`;
 *  - 411 when the body is chunked (`Transfer-Encoding: chunked`) with NO Content-Length — such a body
 *    would buffer unbounded (h3 `readRawBody`/`readMultipartFormData` have no size limit), so it must be
 *    rejected BEFORE any handler reads it (closes the public `/api/b24/events` webhook OOM vector too).
 * A request with neither header (a bodyless / `Content-Length: 0` POST) is NOT rejected — only an actual
 * unbounded chunked body is. This makes the missing-length defense safe-by-default for future routes.
 */
export function edgeBodyGuard(contentLength: string | undefined, transferEncoding: string | undefined, max: number): 411 | 413 | null {
  const declared = Number(contentLength ?? '')
  if (Number.isFinite(declared) && declared > max) return 413
  const chunked = (transferEncoding ?? '').toLowerCase().includes('chunked')
  if (chunked && !contentLength) return 411
  return null
}

// ── Request-time limits (#322): the no-nginx analog of client_header_timeout / client_body_timeout ──
//
// nginx (nginx.conf) enforces client_header_timeout / client_body_timeout (both default 60s — an
// IDLE bound between reads, so an honest slow upload that keeps sending bytes is never cut), and the
// proxy_read_timeout chain bounds totals. Without nginx only Node's defaults apply: requestTimeout
// 300s (total), headersTimeout 60s — and NO idle bound, so a drip-feed body (1 byte / 30s) holds a
// socket for the full 300s at near-zero cost to the attacker (slowloris by body). A hundred such
// POSTs is a hundred sockets pinned for five minutes each on the single process serving every portal.
//
// The compensation mirrors nginx semantics, applied to the Node http.Server when APP_EDGE_SECURITY=1:
//  - socket idle (server.timeout) ← client_body_timeout: cuts a connection that sent NOTHING for the
//    window. An honest user on a bad channel keeps trickling bytes and is never idle-cut.
//  - requestTimeout stays as the TOTAL ceiling (Node's own default, made explicit + tunable): even a
//    never-idle drip is bounded. 300s comfortably covers the largest legit body (25 MB needs ~7 min
//    at 0.5 Mbit/s — but in-portal uploads ride office channels; the demo caps at 6 MB).
//  - headersTimeout ← client_header_timeout.
// Behind nginx (flag off) none of this is applied — nginx already owns these bounds.
//
// Live-verified on the built server (2026-08-01): a declared-1000-byte POST that sends 10 bytes and
// goes silent is cut at exactly the idle bound; a never-idle 1-byte/2s drip is cut by the total
// ceiling (COARSELY — Node enforces requestTimeout on a periodic connections check, so the actual
// cut lands up to ~2 check intervals past the deadline; the bound is «total + minutes», not exact);
// a normal POST passes; with the flag off nothing is applied (Node defaults).
const EDGE_TIMEOUT_DEFAULTS = { socketIdleMs: 60_000, headersTimeoutMs: 60_000, requestTimeoutMs: 300_000 }

/** Clamp an env override into a sane band: below 5s cuts honest clients mid-handshake, above 1h is no
 *  protection at all. Absent/invalid env → the default. */
function timeoutFromEnv(raw: string | undefined, fallback: number): number {
  const n = Number((raw ?? '').trim())
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.max(n, 5_000), 3_600_000)
}

/** Resolved edge timeouts (ms) from env, with nginx-parity defaults. Pure → unit-tested. */
export function edgeTimeouts(env: Record<string, string | undefined>): { socketIdleMs: number, headersTimeoutMs: number, requestTimeoutMs: number } {
  return {
    socketIdleMs: timeoutFromEnv(env.EDGE_SOCKET_IDLE_MS, EDGE_TIMEOUT_DEFAULTS.socketIdleMs),
    headersTimeoutMs: timeoutFromEnv(env.EDGE_HEADERS_TIMEOUT_MS, EDGE_TIMEOUT_DEFAULTS.headersTimeoutMs),
    requestTimeoutMs: timeoutFromEnv(env.EDGE_REQUEST_TIMEOUT_MS, EDGE_TIMEOUT_DEFAULTS.requestTimeoutMs)
  }
}

/** Minimal shape of node:http Server this module needs (keeps the util import-free and testable). */
export interface TimeoutServer {
  timeout: number
  headersTimeout: number
  requestTimeout: number
  setTimeout: (ms: number) => unknown
}

/** Apply the resolved timeouts to a live http.Server. Idempotent — safe to call per request; the
 *  plugin still gates it to once. `setTimeout` (not just the property) so already-open sockets get
 *  the idle bound too. */
export function applyEdgeTimeouts(server: TimeoutServer, t: ReturnType<typeof edgeTimeouts>): void {
  server.setTimeout(t.socketIdleMs)
  server.headersTimeout = t.headersTimeoutMs
  server.requestTimeout = t.requestTimeoutMs
}
