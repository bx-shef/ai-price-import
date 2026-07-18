import { dbEnabled, getPool } from '../db/client'
import { SCHEMA_SQL } from '../db/schema'

// Idempotent schema migration on boot (no-op without DATABASE_URL / at prerender).
// RUN_MIGRATION=0 opts a container OUT (the documented worker-replica role — runtime.ts /
// plugins/queue.ts): only the primary/backend migrates, scaled worker replicas skip it so N
// instances don't race the same CREATE-IF-NOT-EXISTS. Unset (or any non-'0') → migrate, so the
// default single-backend deploy is unchanged. The SQL is idempotent regardless; the gate just
// honors the contract the comments already advertise.
export default defineNitroPlugin(async () => {
  if (import.meta.prerender || !dbEnabled()) return
  if (process.env.RUN_MIGRATION === '0') {
    console.info('[db] migration skipped (RUN_MIGRATION=0)')
    return
  }
  try {
    await getPool().query(SCHEMA_SQL)
    console.info('[db] schema ensured')
  } catch (err) {
    console.error('[db] migration failed', (err as Error).message)
  }
})
