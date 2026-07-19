import type { RestCall } from './b24Rest'

// Store the source file on the COMMON Bitrix24 Disk: app folder → monthly subfolder.
// Live-verified (B24_HOOK, scope disk): disk.storage.getlist returns the common drive with
// ENTITY_TYPE='common' and ROOT_OBJECT_ID (its root folder id); addsubfolder/uploadfile под
// корнем и подпапками отрабатывают, файл загружается и возвращает ID.

interface DiskStorage { ID: string, ENTITY_TYPE: string, NAME: string, ROOT_OBJECT_ID?: string }

/** App folder name under the common drive root (all import source files live here). */
export const DISK_APP_FOLDER = 'procure-ai (импорт прайсов)'

/** Max Disk file name length (kept well under B24's limit); strips path separators. */
export function sanitizeFileName(name: string): string {
  const base = (name ?? '').replace(/[/\\]/g, '_').trim() || 'document'
  return base.slice(0, 255)
}

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

/** Find a FILE (not folder) by exact name under a folder; returns its id or null.
 *  Filters by NAME server-side so the check stays correct even when the month folder holds
 *  more than B24's default list page (~50) — no client-side pagination needed (cf. #87). */
export async function findChildFile(folderId: number, name: string, call: RestCall): Promise<DiskFileRef | null> {
  const children = await call('disk.folder.getchildren', { id: folderId, filter: { NAME: name } }) as Array<{ ID: string, NAME: string, TYPE: string, DETAIL_URL?: string }>
  const existing = (children ?? []).find(c => c.TYPE === 'file' && c.NAME === name)
  return existing ? { id: Number(existing.ID), detailUrl: String(existing.DETAIL_URL ?? '') } : null
}

/** A saved Disk file: its id + `DETAIL_URL` (in-portal "open" link, for the timeline дело button). */
export interface DiskFileRef {
  id: number
  detailUrl: string
}

/** Upload a base64 file into a folder; returns the disk file id + its DETAIL_URL. */
export async function uploadFile(folderId: number, fileName: string, base64: string, call: RestCall): Promise<DiskFileRef> {
  const res = await call('disk.folder.uploadfile', {
    id: folderId,
    data: { NAME: fileName },
    fileContent: [fileName, base64]
  }) as { ID: string, DETAIL_URL?: string }
  return { id: Number(res.ID), detailUrl: String(res.DETAIL_URL ?? '') }
}

/**
 * Save a source file onto the COMMON Disk: common storage → app folder → monthly subfolder
 * → upload. Idempotent folders (ensureSubfolder find-or-create). Returns the disk file id.
 * Live-verified end-to-end (storage/root → app folder → month → uploadfile → delete). Pure
 * over RestCall; `date` injected. Throws when the common drive isn't found (best-effort caller).
 *
 * Idempotent on the FILE too: `disk.folder.uploadfile` has no name pre-check, so a re-run would
 * duplicate the client document. The caller passes a job-scoped `fileName` (`<jobId>__<name>`),
 * so a same-name file already in the month folder means "this job already archived" → return it
 * instead of re-uploading. (Distinct jobs keep distinct names, so this never collapses two docs.)
 *
 * NOTE on concurrency: the folder walk (find-or-create) and this check-then-upload are NOT atomic
 * — B24 Disk has no atomic create-if-absent. Two writers racing on the SAME portal could still
 * duplicate the shared folders or the file. That race is closed one level up by serializing the
 * Disk write per portal (`makeSaveSourceFile`'s `serialize` hook); this function assumes it runs
 * under that per-portal lock in production.
 */
export async function saveSourceFileToDisk(
  input: { base64: string, fileName: string, date: { getFullYear: () => number, getMonth: () => number } },
  call: RestCall
): Promise<DiskFileRef> {
  const storages = await call('disk.storage.getlist') as DiskStorage[] | undefined
  const common = pickCommonStorage(storages ?? [])
  const rootId = Number(common?.ROOT_OBJECT_ID)
  if (!common || !Number.isInteger(rootId) || rootId <= 0) throw new Error('disk: общий диск не найден')
  const appFolderId = await ensureSubfolder(rootId, DISK_APP_FOLDER, call)
  const monthId = await ensureSubfolder(appFolderId, monthlySubfolderName(input.date), call)
  const name = sanitizeFileName(input.fileName)
  const already = await findChildFile(monthId, name, call)
  if (already) return already
  return uploadFile(monthId, name, input.base64, call)
}

/** Injected deps for the file-extract `saveSourceFile` hook (kept pure for tests). */
export interface SaveSourceFileDeps {
  /** Resolve the portal transport once (null = no token → skip). */
  resolveCall: (memberId: string) => Promise<{ call: RestCall } | null>
  /** Read the portal mapping over the SAME transport (so it isn't built twice). */
  loadMapping: (call: RestCall) => Promise<{ saveFile: boolean }>
  /** Read the raw uploaded bytes for the job. */
  readBytes: (memberId: string, jobId: string) => Promise<Uint8Array>
  /**
   * Optional per-portal serializer (advisory lock). Bitrix24 Disk has no atomic
   * "create-if-absent", so the find-or-create folder walk (`ensureSubfolder`) and the
   * check-then-upload (`findChildFile`→`uploadFile`) would race across scale-out workers:
   * two extract jobs for the SAME portal could duplicate the shared app/month folders or
   * (a stalled-job re-run) the same file. Serializing the Disk write per portal removes both
   * races. Omitted in tests (runs `fn` inline) — the pure composition doesn't need a lock.
   */
  serialize?: (key: string, fn: () => Promise<void>) => Promise<void>
  /** Optional: persist the archived file ref (id + DETAIL_URL) so crm-sync can link it on the
   *  timeline дело (#129 follow-up). Best-effort — a persistence failure must not fail the import. */
  recordDiskFile?: (memberId: string, jobId: string, ref: DiskFileRef) => Promise<void>
  now: () => number
}

/**
 * Build the best-effort `saveSourceFile(memberId, jobId, fileId)` hook wired for file-extract.
 * Resolves ONE portal transport and reuses it for both the mapping read and the Disk upload
 * (no double token-load/SDK-build). Gated on the portal's `saveFile` toggle. The archived name
 * is job-scoped (`<jobId>__<fileId>`), and the Disk write runs under an optional per-portal
 * serializer, so both a sequential job retry AND concurrent scale-out workers are idempotent.
 */
export function makeSaveSourceFile(deps: SaveSourceFileDeps): (memberId: string, jobId: string, fileId: string) => Promise<void> {
  return async (memberId, jobId, fileId) => {
    const t = await deps.resolveCall(memberId)
    if (!t) return
    const mapping = await deps.loadMapping(t.call)
    if (!mapping.saveFile) return
    const bytes = await deps.readBytes(memberId, jobId)
    let ref: DiskFileRef | null = null
    const write = async (): Promise<void> => {
      ref = await saveSourceFileToDisk(
        { base64: Buffer.from(bytes).toString('base64'), fileName: `${jobId}__${fileId}`, date: new Date(deps.now()) },
        t.call
      )
    }
    // Serialize only the Disk write (folder walk + upload) per portal — the mapping read and
    // byte read above don't touch the shared folders, so they stay outside the lock.
    if (deps.serialize) await deps.serialize(`disk-archive:${memberId}`, write)
    else await write()
    // Persist the ref (outside the lock) so crm-sync can add an «Исходный файл» link to the дело.
    if (ref && deps.recordDiskFile) await deps.recordDiskFile(memberId, jobId, ref)
  }
}
