// Compensating edge protections for the "black hole" (Bitrix24 Vibecode) deploy target, where the
// app runs as a single Nitro process directly internet-facing with NO nginx in front — so the CSP /
// security headers / HSTS that nginx.conf normally provides, and the login `limit_req`, are absent.
// These are gated behind APP_EDGE_SECURITY so they are a NO-OP behind nginx (default), avoiding a
// double CSP header (multiple CSP headers intersect restrictively) or a login throttle that would
// bucket every client under the shared proxy IP. Pure + DI on env → unit-tested. See docs/DEPLOY_VIBECODE.md.

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
  if (!edgeOn || trustXff) return clientKey(xff, remote)
  return (remote ?? '').trim() || 'unknown'
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
