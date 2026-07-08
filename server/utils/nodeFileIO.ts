import { mkdir, unlink, writeFile } from 'node:fs/promises'
import type { FileIO } from './fileStore'

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
