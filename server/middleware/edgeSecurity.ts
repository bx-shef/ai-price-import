import { buildSecurityHeaders, edgeSecurityEnabled, normalisePathname } from '../utils/edgeSecurity'

// When APP_EDGE_SECURITY is on (the no-nginx "black hole" target), attach the security headers nginx
// would otherwise provide. No-op behind nginx (default) so we never emit a second, conflicting CSP.
export default defineEventHandler((event) => {
  if (!edgeSecurityEnabled(process.env)) return
  const pathname = normalisePathname(event.path ?? '/')
  for (const [k, v] of Object.entries(buildSecurityHeaders(pathname))) setResponseHeader(event, k, v)
})
