import type { Worker } from 'bullmq'
import { queueEnabled } from '../queue/connection'
import { buildLiveInfra, startEventWorker, startThroughputWorkers } from '../queue/worker'
import { liveKeepAliveDeps } from '../queue/liveDeps'
import { queueRuntimeConfig } from '../queue/runtime'
import { keepAliveIntervalMs, runTokenKeepAlive } from '../utils/tokenKeepAlive'

// Nitro startup plugin: start the BullMQ workers in this instance, gated by the queue
// role (QUEUE_WORKERS / QUEUE_CRON — see runtime.ts). No-op without Redis (SSG/dev).
//
// One image, three roles (scale-out; ported from client-bank):
//   - single container (default): throughput workers + event worker here;
//   - HTTP/primary (QUEUE_WORKERS=0): serves the API + runs the SINGLE event worker;
//   - worker (QUEUE_CRON=0, RUN_MIGRATION=0), scaled to N replicas: drain extract/agent/
//     crm-sync only. Redis hands each job to exactly one replica.
// The b24-events worker rides on the cron/primary instance ONLY (install/uninstall must
// stay single-instance/ordered — the tombstone guard is TOCTOU-free only under one consumer).
export default defineNitroPlugin((nitroApp) => {
  if (import.meta.prerender) return
  if (!queueEnabled()) return

  const role = queueRuntimeConfig()
  const infra = (role.workers || role.cron) ? buildLiveInfra() : null
  const workers: Worker[] = []
  let keepAliveTimer: ReturnType<typeof setInterval> | undefined

  if (role.workers && infra) {
    workers.push(...startThroughputWorkers(infra))
    console.info('[queue] throughput workers started (extract/agent/crm-sync)')
  } else if (!role.workers) {
    // Loud: this instance won't drain the pipeline. A worker container MUST be running,
    // else uploads pile up silently (Redis up ⇒ enqueue succeeds ⇒ no sync fallback).
    console.warn('[queue] QUEUE_WORKERS=0 — this instance does NOT process extract/agent/crm-sync; a worker container MUST be running or those queues never drain')
  }

  // The SINGLE b24-events worker runs on the cron/primary instance (QUEUE_CRON=1), so
  // install/uninstall stay ordered even when the throughput `worker` service is scaled.
  if (role.cron && infra) {
    const events = startEventWorker(infra)
    if (events) {
      workers.push(events)
      console.info('[queue] b24-events worker started (single primary instance)')
    }

    // Proactive OAuth keep-alive (#175): an installed-but-idle portal makes no REST calls,
    // so the lazy refresh never fires and its refresh_token dies on day 180. Once a day,
    // refresh ONLY portals within ~3d of expiry. Needs the app creds; without them skip loud.
    const hasOAuthCreds = !!(process.env.B24_CLIENT_ID?.trim() && process.env.B24_CLIENT_SECRET?.trim())
    if (hasOAuthCreds) {
      const keepAliveDeps = liveKeepAliveDeps(infra)
      const keepAliveMs = keepAliveIntervalMs(Number(process.env.TOKEN_KEEPALIVE_HOURS || 24))
      const runKeepAlive = async () => {
        try {
          await runTokenKeepAlive(keepAliveDeps)
        } catch (err) {
          // Only a failure of the initial SELECT reaches here (per-portal failures are
          // isolated inside runTokenKeepAlive). Never let it crash the cron instance.
          console.error('[queue] token keep-alive run failed:', (err as Error)?.message)
        }
      }
      keepAliveTimer = setInterval(runKeepAlive, keepAliveMs)
      void runKeepAlive() // once at boot (cheap: a range scan + refresh of only near-expiry portals)
      console.info('[queue] token keep-alive scheduled (every %d h, #175)', keepAliveMs / 3_600_000)
    } else {
      console.warn('[queue] token keep-alive disabled — B24_CLIENT_ID/SECRET unset (idle portals may lose auth on day 180)')
    }
  } else if (!role.cron) {
    console.info('[queue] QUEUE_CRON=0 — b24-events worker + keep-alive run on the primary instance, not here')
  }

  nitroApp.hooks.hook('close', async () => {
    if (keepAliveTimer) clearInterval(keepAliveTimer)
    await Promise.all(workers.map(w => w.close()))
  })
})
