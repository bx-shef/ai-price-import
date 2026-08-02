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

/** Максимальная длина имени архивной копии — тот же предел, что у `sanitizeFileName`. */
export const MAX_DISK_NAME = 255

/**
 * Имя архивной копии на Диске: `накладная__<jobId>.pdf` (#346).
 *
 * Раньше было `<jobId>__накладная.pdf`, и первые 38 знаков имени у ВСЕХ файлов совпадали: в списке
 * папки человек видел столбец одинаковых UUID, сортировка шла по случайному идентификатору, а найти
 * свою загрузку глазами было нельзя.
 *
 * Три вещи, которые схема обязана сохранить, — каждая ломалась «упрощением» имени:
 *
 * 1. **Уникальность.** `jobId` тут не украшение: перед загрузкой идёт `findChildFile` по точному
 *    имени, и именно оно не даёт повторному прогону задания задвоить файл. Поэтому идентификатор
 *    остаётся в имени целиком — он просто переезжает в конец.
 * 2. **Расширение.** Оно должно остаться ПОСЛЕДНИМ, иначе портал и операционная система перестают
 *    понимать тип файла.
 * 3. **Обрезка.** Режется только именная часть, а `__<jobId>` и расширение дописываются ПОСЛЕ
 *    обрезки. Прежняя схема резала строку целиком, и это было безопасно лишь потому, что длинное
 *    имя стояло в хвосте. Перенеси его в начало, оставь `slice(255)` — и у длинного имени отвалятся
 *    и идентификатор, и расширение, то есть ровно те две вещи, ради которых схема существует.
 */
export function archiveFileName(jobId: string, fileName: string): string {
  // ⚠ Сюда НЕЛЬЗЯ подставить `sanitizeFileName`: он режет строку по 255 ПЕРЕД тем, как мы разберём
  // расширение, — у имени длиннее предела расширение отваливается ещё до разбора, и файл уходит на
  // Диск без него. Поэтому чистим то же самое (разделители пути, пробелы по краям, пустое имя), но
  // БЕЗ обрезки: длину доводим ниже, уже зная, что жертвовать можно только именной частью.
  const clean = (fileName ?? '').replace(/[/\\]/g, '_').trim() || 'document'
  // Расширение — только настоящее: точка в конце имени («отчёт.») и файл без точки вовсе дают
  // пустой суффикс, а не «расширение» из хвоста имени.
  const dot = clean.lastIndexOf('.')
  const hasExt = dot > 0 && dot < clean.length - 1
  const ext = hasExt ? clean.slice(dot) : ''
  const stem = hasExt ? clean.slice(0, dot) : clean
  const suffix = `__${jobId}${ext}`
  // Имя целиком не влезает ⇒ жертвуем именной частью, а не идентификатором с расширением. Если
  // даже на один знак имени не осталось (сверхдлинный jobId), возвращаем суффикс как есть:
  // нечитаемое имя лучше, чем неуникальное или без расширения.
  const room = MAX_DISK_NAME - suffix.length
  if (room <= 0) return suffix.slice(-MAX_DISK_NAME)
  return `${stem.slice(0, room)}${suffix}`
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

/** In-portal view URL for a file on the COMMON drive, addressed by its human path under the drive root
 *  (`/docs/file/<appFolder>/<month>/<name>`). The `?IFRAME=Y&IFRAME_TYPE=SIDE_SLIDER` suffix opens it in
 *  a portal side-slider (the form owner confirmed as the working link). We CONSTRUCT this rather than use
 *  the API's DETAIL_URL because DETAIL_URL points at the id-based document route, which did not open the
 *  file. Each segment is `encodeURIComponent`-encoded (space → %20, `()` → %28/%29), matching the portal's
 *  own URL form. Returned RELATIVE (leading `/`) so it stays same-portal (SSRF-safe) and survives
 *  detailUrlToRelative unchanged (query kept). */
export function commonDiskFileUrl(appFolder: string, month: string, fileName: string): string {
  // encodeURIComponent leaves `!'()*` unescaped, but the portal's own URL encodes parentheses
  // (`(` → %28, `)` → %29). Escape that whole sub-delim set too so the path matches byte-for-byte.
  const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  const seg = [appFolder, month, fileName].map(enc).join('/')
  return `/docs/file/${seg}?IFRAME=Y&IFRAME_TYPE=SIDE_SLIDER`
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
  const monthName = monthlySubfolderName(input.date)
  const monthId = await ensureSubfolder(appFolderId, monthName, call)
  const name = sanitizeFileName(input.fileName)
  // The OPEN link is CONSTRUCTED from the human path (not the API's DETAIL_URL, which didn't open the
  // file). Same for a freshly-uploaded and an already-archived file → the id from REST, the URL from us.
  const detailUrl = commonDiskFileUrl(DISK_APP_FOLDER, monthName, name)
  const already = await findChildFile(monthId, name, call)
  if (already) return { id: already.id, detailUrl }
  const uploaded = await uploadFile(monthId, name, input.base64, call)
  return { id: uploaded.id, detailUrl }
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
 * (no double token-load/SDK-build). Gated on the portal's `saveFile` toggle. The archived name is
 * job-scoped (`<имя>__<jobId>.<ext>`, см. `archiveFileName`), and the Disk write runs under an
 * optional per-portal serializer, so both a sequential job retry AND concurrent scale-out workers
 * are idempotent.
 *
 * ⚠ Файлы, загруженные до #346, лежат под старым именем `<jobId>__<имя>` — миграция им не нужна:
 * ссылка «Исходный файл» в деле строится из СОХРАНЁННОГО в задании `diskFile`, а не пересобирается
 * из имени на лету. Единственное следствие — повторный прогон СТАРОГО задания не найдёт свою
 * прежнюю копию по новому имени и загрузит вторую. Это возможно лишь пока живо задание тех суток
 * (TTL 48 ч), и цена — одна лишняя копия, а не потеря.
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
        { base64: Buffer.from(bytes).toString('base64'), fileName: archiveFileName(jobId, fileId), date: new Date(deps.now()) },
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
