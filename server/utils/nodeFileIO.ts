import { mkdir, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { type FileIO, safeSeg, UPLOAD_DIR, uploadPath } from './fileStore'

// node:fs implementation of the injectable FileIO (used by the upload route and
// the extract worker). Kept separate so pure fileStore stays node-free/testable.
export const nodeFileIO: FileIO = {
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true })
  },
  writeFile: async (path, data) => {
    await writeFile(path, data)
  },
  unlink: async (path) => {
    await unlink(path)
  }
}

/**
 * Read a job's retained upload bytes as base64 for the feedback attachment (#200), or null when the
 * file is gone (already swept) or bigger than `maxBytes`. The cap mirrors the Disk path
 * (`downloadDiskFile`): 5 MB is far above any invoice and keeps one request from buffering a huge
 * file into RAM. `stat` first, so an over-cap file is rejected WITHOUT reading it.
 */
export async function readUploadBase64(memberId: string, jobId: string, maxBytes = 5 * 1024 * 1024): Promise<string | null> {
  const path = uploadPath(memberId, jobId)
  try {
    const st = await stat(path)
    if (!st.isFile() || st.size === 0 || st.size > maxBytes) return null
    return (await readFile(path)).toString('base64')
  } catch {
    return null // swept, never written, or unreadable — the issue is filed without the file
  }
}

/** Remove a portal's entire upload directory (ONAPPUNINSTALL — client-data purge on
 * disk, complementing the DB purge in deletePortal). Best-effort. */
export async function purgePortalFiles(memberId: string): Promise<void> {
  await rm(`${UPLOAD_DIR}/${safeSeg(memberId)}`, { recursive: true, force: true }).catch(() => {})
}

/**
 * Delete upload bytes older than `maxAgeMs`. This is the PRIMARY retention path now (#200), not the
 * orphan backstop it started as: the extract worker no longer deletes the file on its way out, because
 * a 👎 on «документ не распознан» has nothing else to attach — that case writes neither a CRM entity
 * nor a Disk archive. The window therefore has to match how long a job can still be rated, i.e. the
 * job TTL; the caller passes it (default here only guards a caller that forgets).
 * Best-effort per file: one unreadable entry must not stop the sweep.
 */
/** How long an upload may sit on disk before the sweep treats it as an ORPHAN (#349). The extract
 *  worker deletes bytes as soon as the text is out, so a file older than this belongs to a job that
 *  never got extracted (crash / lost queue message). Hours, not days: a live job needs its file for
 *  minutes, and holding a client's document longer is exactly what the owner declined. */
export const UPLOAD_ORPHAN_MAX_AGE_MS = 6 * 60 * 60 * 1000

export async function sweepOldUploads(maxAgeMs = UPLOAD_ORPHAN_MAX_AGE_MS, now = Date.now()): Promise<number> {
  let removed = 0
  let members: string[]
  try {
    members = await readdir(UPLOAD_DIR)
  } catch {
    return 0 // dir absent → nothing to sweep
  }
  for (const member of members) {
    const dir = `${UPLOAD_DIR}/${member}`
    let files: string[]
    try {
      files = await readdir(dir)
    } catch {
      continue
    }
    for (const f of files) {
      const p = `${dir}/${f}`
      try {
        const s = await stat(p)
        if (now - s.mtimeMs > maxAgeMs) {
          await unlink(p)
          removed++
        }
      } catch { /* raced/gone */ }
    }
  }
  return removed
}
