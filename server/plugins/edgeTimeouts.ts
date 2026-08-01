import type { Server } from 'node:http'
import { applyEdgeTimeouts, edgeSecurityEnabled, edgeTimeouts } from '../utils/edgeSecurity'

// Slowloris compensation for the no-nginx target (#322): apply socket-idle / headers / total request
// timeouts to the live http.Server — the analog of nginx client_body_timeout / client_header_timeout
// (see the rationale block next to `edgeTimeouts` in server/utils/edgeSecurity.ts).
//
// Nitro never hands plugins the http.Server directly, so it is grabbed from the FIRST request's
// socket (`req.socket.server`) — one flag makes that once-only. The window before the first request
// needs no protection: with zero requests there are no attacker-held request sockets yet, and
// `server.setTimeout` also covers connections that are already open when it runs.
//
// Behind nginx (flag off, the default) this is a no-op: nginx already bounds header/body time, and a
// second layer here would only add a knob that can silently disagree with nginx.conf.
export default defineNitroPlugin((nitroApp) => {
  if (import.meta.prerender) return
  if (!edgeSecurityEnabled(process.env)) return
  const t = edgeTimeouts(process.env)
  let applied = false
  nitroApp.hooks.hook('request', (event) => {
    if (applied) return
    const server = (event.node.req.socket as { server?: Server } | undefined)?.server
    if (!server) return // keep trying on the next request (e.g. a synthetic/local call had no socket)
    applyEdgeTimeouts(server, t)
    applied = true
    console.info(`[edge] request timeouts applied: idle=${t.socketIdleMs}ms headers=${t.headersTimeoutMs}ms total=${t.requestTimeoutMs}ms`)
  })
})
