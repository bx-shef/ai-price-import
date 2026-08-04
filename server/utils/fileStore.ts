// Uploaded-file storage on local disk, scoped by portal+job. The bytes never ride
// in a queue payload — file-extract reads them by (memberId, jobId). Path building is
// traversal-safe and pure (tested); the fs ops are injected (FileIO) → also testable.
//
// RETENTION (#349 — the #200 retention was REVERTED). The raw file is deleted the moment its text is
// extracted, so it lives on our disk for seconds. #200 had kept it for the job's whole TTL to give
// «документ не распознан» something to attach to a 👎 (that case writes neither a CRM entity nor a
// Disk archive) — the owner is not willing to hold client documents that long, and the feedback
// widget now sends the copy the PAGE still holds instead. `sweepOldUploads` is back to being an
// orphan backstop for jobs that never reached extraction; uninstall purges a portal at once.
//
// Consequence for ops: peak disk is bounded by files in flight, not by a retention window, so the
// old «watch UPLOAD_DIR, shrink IMPORT_JOB_TTL_HOURS» advice no longer applies.

// ⚠ Дефолтный путь НЕ переименован вместе с продуктом (#412), и это осознанно. Здесь лежат
// документы клиента, а подметает их только обход этого каталога (`sweepOldUploads`) и очистка при
// удалении портала (`purgePortalFiles`). На Вайбкод-развёртывании `UPLOAD_DIR` в env не задаётся —
// значит смена дефолта увела бы оба обхода на новый каталог, а всё, что лежало в старом, осталось
// бы на диске навсегда и мимо очистки. Человек этот путь не видит: он в том же классе, что имена
// образов и базы.
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
