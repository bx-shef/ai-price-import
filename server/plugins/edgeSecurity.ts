import { buildSecurityHeaders, edgeSecurityEnabled, normalisePathname } from '../utils/edgeSecurity'

// Security headers for the no-nginx ("black hole") target — attached from a `request` HOOK, not from
// server/middleware.
//
// WHY THE HOOK. Nitro registers the public-assets handler as the FIRST middleware, and it answers and
// RETURNS for any prerendered file. Every HTML page here is prerendered (`/`, `/app`, `/settings`,
// `/import`, `/install`, `/login`, `/queues`, `/metrics`, `public/b24-form.html`), so a middleware in
// `server/middleware/` never runs for them: live-checked on the built output, `GET /app` came back with
// NO Content-Security-Policy while `GET /api/health` carried the full set. That is exactly backwards —
// `frame-ancestors` (clickjacking) protects HTML pages, and the API routes that did get it have no
// markup to frame. The `request` hook fires before ANY handler, static included, so headers land on
// every response.
//
// The body guard stays in `server/middleware/edgeSecurity.ts`: it must be able to ABORT the request,
// and a throw inside this hook is swallowed by Nitro's `.catch(captureError)`. Static GETs carry no
// body, so nothing is lost by guarding bodies one step later.
export default defineNitroPlugin((nitroApp) => {
  if (!edgeSecurityEnabled(process.env)) return // no-op behind nginx (default) — never a second CSP
  nitroApp.hooks.hook('request', (event) => {
    const headers = buildSecurityHeaders(normalisePathname(event.path ?? '/'))
    for (const [k, v] of Object.entries(headers)) setResponseHeader(event, k, v)
  })
})
