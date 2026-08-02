import { dbEnabled, query } from '../db/client'
import { resolveTombstoneDays, sweepExpired } from '../utils/retentionSweep'
import { sweepOldUploads, UPLOAD_ORPHAN_MAX_AGE_MS } from '../utils/nodeFileIO'

// Hourly TTL sweep: purge client data (import_text/doc, upload bytes) and cap portal_tombstone
// growth (TTL `TOMBSTONE_TTL_DAYS`, default 30). Safety net for docs/PROCESS.md.
//
// For the upload bytes this is a BACKSTOP AGAINST ORPHANS again (#349): the extract worker deletes
// them the moment the text is out, so anything still on disk belongs to a job that never reached
// extraction (crash, Redis loss, queue drop). #200 had briefly made this the only deletion path and
// kept files for the job's whole TTL so a 👎 could attach them — the owner is not willing to hold
// client documents that long, and the feedback widget now sends bytes from page memory instead.
// The window stays `UPLOAD_ORPHAN_MAX_AGE_MS` — short, because a live job needs its file for minutes,
// not hours.
// No-op without a DB / during prerender.
export default defineNitroPlugin(() => {
  if (import.meta.prerender) return
  if (!dbEnabled()) return

  const tombstoneDays = resolveTombstoneDays(process.env.TOMBSTONE_TTL_DAYS)

  const run = async () => {
    try {
      const r = await sweepExpired(query, 24, tombstoneDays)
      const files = await sweepOldUploads(UPLOAD_ORPHAN_MAX_AGE_MS)
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
