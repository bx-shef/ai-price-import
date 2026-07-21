import { EDGE_MAX_BODY_BYTES, buildSecurityHeaders, edgeSecurityEnabled, normalisePathname } from '../utils/edgeSecurity'

// When APP_EDGE_SECURITY is on (the no-nginx "black hole" target), attach the security headers nginx
// would otherwise provide, and enforce the global body cap nginx's `client_max_body_size` gives.
// No-op behind nginx (default) so we never emit a second, conflicting CSP or double-cap.
export default defineEventHandler((event) => {
  if (!edgeSecurityEnabled(process.env)) return
  const pathname = normalisePathname(event.path ?? '/')
  for (const [k, v] of Object.entries(buildSecurityHeaders(pathname))) setResponseHeader(event, k, v)
  // Global declared-size cap (mirrors nginx client_max_body_size). Rejects an oversized body by its
  // Content-Length before any route buffers it; the upload routes additionally 411 on a missing length.
  const declared = Number(getHeader(event, 'content-length') || 0)
  if (Number.isFinite(declared) && declared > EDGE_MAX_BODY_BYTES) {
    throw createError({ statusCode: 413, statusMessage: 'Payload Too Large' })
  }
})
