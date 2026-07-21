import { withSpan } from './telemetrySpan'
import { portalHash } from './telemetryAttributes'

// Shared manual-OTel wrapper for frame-token HTTP routes (телеметрия, DEFAULT OFF). Emits ONE span
// per request with latency + a PII-safe outcome + hashed portal id — never the request body or any
// business content (mapping / mapping fields / chat ids / document data). Matches the /api/settings
// spans. Zero overhead when telemetry is off (withSpan gates on span.isRecording(); portal.hash is
// computed in finalize, which runs ONLY when recording).
//
// Usage: extract the frame auth first (sync), pass its domain, and set `span.outcome` at each early
// return inside the handler. `http.outcome` is a free-form but conventional label:
//   ok | no_auth | auth_failed | forbidden | bad_request | conflict | unavailable | upstream_error | no_db

export interface RouteSpan { outcome: string }

export interface FrameRouteSpanInfo {
  /** Span name, e.g. 'http.crm-categories.get'. */
  name: string
  /** HTTP verb: 'GET' | 'POST'. */
  method: string
  /** Logical route op, e.g. 'crm-categories.load'. */
  op: string
  /** Portal domain from the frame auth (hashed → portal.hash; undefined ⇒ 'unknown'). */
  domain: string | undefined
}

/** Run a frame-route handler inside a span. The handler mutates `span.outcome` at each return. */
export function withFrameRouteSpan<T>(info: FrameRouteSpanInfo, fn: (span: RouteSpan) => Promise<T>): Promise<T> {
  const span: RouteSpan = { outcome: 'ok' }
  return withSpan(
    info.name,
    { 'http.method': info.method, 'http.op': info.op },
    () => fn(span),
    () => ({ 'http.outcome': span.outcome, 'portal.hash': portalHash(info.domain) })
  )
}
