import type { RestCall } from './b24Rest'

// Store the source file on the COMMON Bitrix24 Disk: app folder → monthly subfolder.
// Live-verified: disk.storage.getlist returns the common drive with ENTITY_TYPE='common'.

interface DiskStorage { ID: string, ENTITY_TYPE: string, NAME: string }

/** Pick the common ("Общий диск") storage from disk.storage.getlist result. */
export function pickCommonStorage(storages: DiskStorage[]): DiskStorage | null {
  return storages.find(s => s.ENTITY_TYPE === 'common') ?? null
}

/** Monthly subfolder name YYYY-MM from a Date (passed in — pure). */
export function monthlySubfolderName(date: { getFullYear: () => number, getMonth: () => number }): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

/** Find or create a subfolder by name under a folder; returns its id. Idempotent. */
export async function ensureSubfolder(folderId: number, name: string, call: RestCall): Promise<number> {
  const children = await call('disk.folder.getchildren', { id: folderId }) as Array<{ ID: string, NAME: string, TYPE: string }>
  const existing = (children ?? []).find(c => c.TYPE === 'folder' && c.NAME === name)
  if (existing) return Number(existing.ID)
  const created = await call('disk.folder.addsubfolder', { id: folderId, data: { NAME: name } }) as { ID: string }
  return Number(created.ID)
}

/** Upload a base64 file into a folder; returns the disk file id. */
export async function uploadFile(folderId: number, fileName: string, base64: string, call: RestCall): Promise<number> {
  const res = await call('disk.folder.uploadfile', {
    id: folderId,
    data: { NAME: fileName },
    fileContent: [fileName, base64]
  }) as { ID: string }
  return Number(res.ID)
}
