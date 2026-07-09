// Uploaded-file storage on local disk, scoped by portal+job. The bytes never ride
// in a queue payload — file-extract reads them by (memberId, jobId). Path building is
// traversal-safe and pure (tested); the fs ops are injected (FileIO) → also testable.
// The raw file is deleted after extraction / on job cleanup (data minimisation, docs 05).

export const UPLOAD_DIR = process.env.UPLOAD_DIR || '/tmp/procure-uploads'

/** Sanitise one path segment: no separators, no '..', bounded. */
export function safeSeg(s: string): string {
  const cleaned = String(s ?? '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.+/g, '.')
  const trimmed = cleaned.replace(/^\.+/, '').slice(0, 128)
  return trimmed || '_'
}

/** Deterministic, traversal-safe path for a job's uploaded bytes. */
export function uploadPath(memberId: string, jobId: string, baseDir = UPLOAD_DIR): string {
  return `${baseDir}/${safeSeg(memberId)}/${safeSeg(jobId)}.bin`
}

export interface FileIO {
  mkdir: (dir: string) => Promise<void>
  writeFile: (path: string, data: Uint8Array) => Promise<void>
  unlink: (path: string) => Promise<void>
}

/** Persist uploaded bytes (creates the portal dir). */
export async function saveUpload(memberId: string, jobId: string, bytes: Uint8Array, io: FileIO, baseDir = UPLOAD_DIR): Promise<string> {
  const path = uploadPath(memberId, jobId, baseDir)
  await io.mkdir(`${baseDir}/${safeSeg(memberId)}`)
  await io.writeFile(path, bytes)
  return path
}

/** Best-effort removal of a job's uploaded bytes. */
export async function deleteUpload(memberId: string, jobId: string, io: FileIO, baseDir = UPLOAD_DIR): Promise<void> {
  try {
    await io.unlink(uploadPath(memberId, jobId, baseDir))
  } catch { /* already gone */ }
}
