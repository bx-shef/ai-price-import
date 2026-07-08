import { queueEnabled } from '../queue/connection'
import { startWorkers } from '../queue/worker'

// Start the BullMQ pipeline workers in-process on backend boot (extract → agent →
// crm-sync). No-op without Redis (queueEnabled() false) — the app still serves the
// landing/UI and events endpoint. Scale-out (separate worker container) is a later step.
export default defineNitroPlugin(() => {
  if (import.meta.prerender) return
  if (!queueEnabled()) return
  try {
    const workers = startWorkers()
    if (workers.length) console.info(`[queue] started ${workers.length} pipeline workers`)
  } catch (e) {
    console.error('[queue] failed to start workers:', e instanceof Error ? e.message : e)
  }
})
