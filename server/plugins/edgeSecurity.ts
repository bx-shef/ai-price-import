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
// every response — verified on 200, 304, HEAD, prerendered pages, /_nuxt assets and /api routes alike.
// One documented exception: on Nitro's own ERROR pages (404/500) it overwrites Content-Security-Policy
// and Referrer-Policy with its own, STRICTER pair (`script-src 'none'; frame-ancestors 'none'`,
// `no-referrer`); nosniff and HSTS survive. Stricter is fine — noted so nobody reads a missing CSP
// there as this hook failing.
//
// The body guard stays in `server/middleware/edgeSecurity.ts`: it must be able to ABORT the request,
// and a throw inside this hook is swallowed by Nitro's `.catch(captureError)`. Static GETs carry no
// body, so nothing is lost by guarding bodies one step later.
export default defineNitroPlugin((nitroApp) => {
  if (import.meta.prerender) return // same guard as the sibling plugins: no runtime work during build
  // Read ONCE at boot, while the middleware re-reads per request. The asymmetry is deliberate and
  // fail-safe in this direction only: were the flag ever to appear after start, you would get the body
  // guard without headers, not headers without the guard. In a container the env is fixed at start.
  if (!edgeSecurityEnabled(process.env)) return // no-op behind nginx (default) — never a second CSP
  nitroApp.hooks.hook('request', (event) => {
    const headers = buildSecurityHeaders(normalisePathname(event.path ?? '/'))
    for (const [k, v] of Object.entries(headers)) setResponseHeader(event, k, v)
  })
})
