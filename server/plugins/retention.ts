import { dbEnabled, query } from '../db/client'
import { resolveTombstoneDays, sweepExpired } from '../utils/retentionSweep'
import { sweepOldUploads } from '../utils/nodeFileIO'
import { JOB_TTL_MS } from '../utils/jobStore'

// Hourly TTL sweep: purge client data (import_text/doc, upload bytes) and cap portal_tombstone
// growth (TTL `TOMBSTONE_TTL_DAYS`, default 30). Safety net for docs/PROCESS.md.
//
// For the upload bytes this is no longer a backstop but the ONLY deletion path (#200) — the extract
// worker stopped dropping them, since a 👎 on a document that produced no CRM entity and no Disk
// archive would otherwise have nothing to attach. Window = `JOB_TTL_MS`, deliberately the SAME knob
// that bounds the job record: a file must outlive the job it belongs to exactly as long as that job
// can still be rated, and one knob cannot drift against itself.
// No-op without a DB / during prerender.
export default defineNitroPlugin(() => {
  if (import.meta.prerender) return
  if (!dbEnabled()) return

  const tombstoneDays = resolveTombstoneDays(process.env.TOMBSTONE_TTL_DAYS)

  const run = async () => {
    try {
      const r = await sweepExpired(query, 24, tombstoneDays)
      const files = await sweepOldUploads(JOB_TTL_MS)
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
