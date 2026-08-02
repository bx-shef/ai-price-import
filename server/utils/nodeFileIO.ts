import { mkdir, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { type FileIO, safeSeg, UPLOAD_DIR } from './fileStore'

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

// NB: there is deliberately NO «read the job's upload for the feedback attachment» helper here any
// more (#349). It existed while #200 retained the bytes; keeping it after the revert would be a
// standing invitation to reintroduce server-side retention. The page sends its own copy instead.

/** Remove a portal's entire upload directory (ONAPPUNINSTALL — client-data purge on
 * disk, complementing the DB purge in deletePortal). Best-effort. */
export async function purgePortalFiles(memberId: string): Promise<void> {
  await rm(`${UPLOAD_DIR}/${safeSeg(memberId)}`, { recursive: true, force: true }).catch(() => {})
}

/** How long an upload may sit on disk before the sweep treats it as an ORPHAN (#349). The extract
 *  worker deletes bytes as soon as the text is out, so a file older than this belongs to a job that
 *  never got extracted (crash / lost queue message). Hours, not days: a live job needs its file for
 *  minutes, and holding a client's document longer is exactly what the owner declined. */
export const UPLOAD_ORPHAN_MAX_AGE_MS = 6 * 60 * 60 * 1000

/** Delete upload bytes older than `maxAgeMs` — an ORPHAN backstop (see the constant above), not a
 *  retention window. Best-effort per file: one unreadable entry must not stop the sweep. */
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
