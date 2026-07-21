import { EDGE_MAX_BODY_BYTES, buildSecurityHeaders, edgeBodyGuard, edgeSecurityEnabled, normalisePathname } from '../utils/edgeSecurity'

// When APP_EDGE_SECURITY is on (the no-nginx "black hole" target), attach the security headers nginx
// would otherwise provide, and enforce the body caps nginx's `client_max_body_size` gives. No-op behind
// nginx (default) so we never emit a second, conflicting CSP or double-cap.
export default defineEventHandler((event) => {
  if (!edgeSecurityEnabled(process.env)) return
  const pathname = normalisePathname(event.path ?? '/')
  for (const [k, v] of Object.entries(buildSecurityHeaders(pathname))) setResponseHeader(event, k, v)
  // Global body guard (safe-by-default for EVERY route, incl. the public /api/b24/events webhook):
  // reject an over-cap declared length (413) or an unbounded chunked body with no length (411) BEFORE
  // any handler reads it. A bodyless / Content-Length:0 request is unaffected.
  const status = edgeBodyGuard(getHeader(event, 'content-length'), getHeader(event, 'transfer-encoding'), EDGE_MAX_BODY_BYTES)
  if (status === 413) throw createError({ statusCode: 413, statusMessage: 'Payload Too Large' })
  if (status === 411) throw createError({ statusCode: 411, statusMessage: 'Length Required' })
})
