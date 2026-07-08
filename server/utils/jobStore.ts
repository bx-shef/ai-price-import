import type { QueryFn } from './tokenStore'

// Per-portal import-job tracking over an injected QueryFn (testable without a DB).

export type JobStatus = 'queued' | 'extracting' | 'processing' | 'done' | 'error'

export interface ImportJob {
  memberId: string
  jobId: string
  status: JobStatus
  fileName: string
  result: string
}

export async function createJob(memberId: string, jobId: string, fileName: string, query: QueryFn): Promise<void> {
  await query(
    `INSERT INTO import_job (member_id, job_id, status, file_name)
     VALUES ($1,$2,'queued',$3)
     ON CONFLICT (member_id, job_id) DO NOTHING`,
    [memberId, jobId, fileName]
  )
}

export async function setJobStatus(memberId: string, jobId: string, status: JobStatus, result: string, query: QueryFn): Promise<void> {
  await query(
    'UPDATE import_job SET status=$3, result=$4, updated_at=now() WHERE member_id=$1 AND job_id=$2',
    [memberId, jobId, status, result]
  )
}

export async function getJob(memberId: string, jobId: string, query: QueryFn): Promise<ImportJob | null> {
  const { rows } = await query('SELECT * FROM import_job WHERE member_id=$1 AND job_id=$2', [memberId, jobId])
  const r = rows[0]
  if (!r) return null
  return {
    memberId: String(r.member_id),
    jobId: String(r.job_id),
    status: String(r.status) as JobStatus,
    fileName: String(r.file_name ?? ''),
    result: String(r.result ?? '')
  }
}
