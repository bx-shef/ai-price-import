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

/** Remove a portal's entire upload directory (ONAPPUNINSTALL — client-data purge on
 * disk, complementing the DB purge in deletePortal). Best-effort. */
export async function purgePortalFiles(memberId: string): Promise<void> {
  await rm(`${UPLOAD_DIR}/${safeSeg(memberId)}`, { recursive: true, force: true }).catch(() => {})
}

/** TTL backstop for orphaned upload bytes: delete .bin files older than maxAgeMs
 * (normally removed within minutes by the extract worker). Best-effort. */
export async function sweepOldUploads(maxAgeMs = 6 * 60 * 60 * 1000, now = Date.now()): Promise<number> {
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
