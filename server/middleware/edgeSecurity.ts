import { EDGE_MAX_BODY_BYTES, edgeBodyGuard, edgeSecurityEnabled } from '../utils/edgeSecurity'

// When APP_EDGE_SECURITY is on (the no-nginx "black hole" target), enforce the body caps nginx's
// `client_max_body_size` gives. No-op behind nginx (default) so we never double-cap.
//
// The security HEADERS moved to `server/plugins/edgeSecurity.ts` (a `request` hook): Nitro's
// public-assets handler runs before this middleware and returns for every prerendered page, so
// headers set here never reached the HTML. The guard below stays here because it must ABORT the
// request — a throw inside the hook is swallowed by Nitro's captureError.
export default defineEventHandler((event) => {
  if (!edgeSecurityEnabled(process.env)) return
  // Global body guard (safe-by-default for EVERY route, incl. the public /api/b24/events webhook):
  // reject an over-cap declared length (413) or an unbounded chunked body with no length (411) BEFORE
  // any handler reads it. A bodyless / Content-Length:0 request is unaffected.
  const status = edgeBodyGuard(getHeader(event, 'content-length'), getHeader(event, 'transfer-encoding'), EDGE_MAX_BODY_BYTES)
  if (status === 413) throw createError({ statusCode: 413, statusMessage: 'Payload Too Large' })
  if (status === 411) throw createError({ statusCode: 411, statusMessage: 'Length Required' })
})
