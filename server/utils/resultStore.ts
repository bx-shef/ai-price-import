import type { QueryFn } from './tokenStore'

// crm-sync idempotency checkpoint (job_result): the created entity id per job,
// written the moment the entity is created (before its rows). On retry crm-sync
// finds it and resumes instead of creating a duplicate. DI over QueryFn.

export async function getExistingResult(memberId: string, jobId: string, query: QueryFn): Promise<{ entityTypeId: number, entityId: number } | null> {
  const { rows } = await query('SELECT entity_type_id, entity_id FROM job_result WHERE member_id=$1 AND job_id=$2', [memberId, jobId])
  const r = rows[0]
  if (!r) return null
  const entityTypeId = Number(r.entity_type_id)
  const entityId = Number(r.entity_id)
  return Number.isFinite(entityTypeId) && Number.isFinite(entityId) ? { entityTypeId, entityId } : null
}

/** Write-once checkpoint (ON CONFLICT DO NOTHING — a retry never overwrites). */
export async function recordResult(memberId: string, jobId: string, entityTypeId: number, entityId: number, query: QueryFn): Promise<void> {
  await query(
    `INSERT INTO job_result (member_id, job_id, entity_type_id, entity_id) VALUES ($1,$2,$3,$4)
     ON CONFLICT (member_id, job_id) DO NOTHING`,
    [memberId, jobId, entityTypeId, entityId]
  )
}
