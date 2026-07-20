import { dbEnabled, query } from '../db/client'
import { resolveTombstoneDays, sweepExpired } from '../utils/retentionSweep'
import { sweepOldUploads } from '../utils/nodeFileIO'

// Hourly TTL sweep: purge orphaned client data (import_text/doc, old terminal jobs,
// stale upload bytes) the live cleanup paths missed, and cap portal_tombstone growth
// (TTL `TOMBSTONE_TTL_DAYS`, default 30). Safety net for docs/redesign 05.
// No-op without a DB / during prerender.
export default defineNitroPlugin(() => {
  if (import.meta.prerender) return
  if (!dbEnabled()) return

  const tombstoneDays = resolveTombstoneDays(process.env.TOMBSTONE_TTL_DAYS)

  const run = async () => {
    try {
      const r = await sweepExpired(query, 24, tombstoneDays)
      const files = await sweepOldUploads()
      if (r.text || r.docs || r.tombstones || files) {
        console.info(`[retention] swept text=${r.text} docs=${r.docs} tombstones=${r.tombstones} files=${files}`)
      }
    } catch (e) {
      console.error('[retention] sweep failed:', e instanceof Error ? e.message : e)
    }
  }

  void run() // once on boot
  setInterval(() => void run(), 60 * 60 * 1000).unref?.()
})
