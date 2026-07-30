import { ref, computed } from 'vue'
import { useB24 } from './useB24'
import { buildFrameHeaders, fetchErrorMessage } from '~/utils/frameHeaders'
import { jobStatusMeta, type JobStatus } from '~/utils/jobStatus'
import { nextPollDelay } from '~/utils/pollBackoff'
import { addImportJob, clearImportHistory, importJobIds, readHistory, removeImportJob } from '~/utils/importHistory'
import { mergeJobRows } from '~/utils/importMerge'
import { truncationWarning } from '~~/server/utils/importStatusIds'
import { classifyUploadError, type UploadOutcome } from '~/utils/importUpload'
import type { TargetRef } from '~/types/mapping'

// In-portal import client: upload a document and poll job status via the frame-token
// authenticated API (/api/import/*). Inert outside a portal (no frame auth). Auto-polls the status
// while any job is still running (queued/extracting/processing) so the /app progress moves on its
// own, and stops once everything is terminal (done/error) — no idle polling.

export interface ImportJobView {
  jobId: string
  status: JobStatus
  fileName: string
  result: string
  diskUrl?: string
  /** CRM type the employee chose for this file, when they chose one manually (#269). */
  targetEntityTypeId?: number
}

export function useImport() {
  const { init, auth } = useB24()
  const jobs = ref<ImportJobView[]>([])
  const loading = ref(false)
  const uploading = ref(false)
  const error = ref('')
  // Separate from `error`, which is shared with upload() and «вне портала». Only set by refresh(), so
  // the empty state can say «историю получить не удалось» without claiming that after a failed UPLOAD.
  const listError = ref('')
  // A SUCCESSFUL poll that couldn't cover every remembered job. Deliberately NOT `listError`: that one
  // feeds the failure streak in scheduleNext, so a warning there would stop auto-polling after five
  // successful-but-truncated answers — exactly for the user with the longest history (#260).
  const listWarning = ref('')

  // Any job not yet in a terminal state → keep polling.
  const hasActive = computed(() => jobs.value.some(j => !jobStatusMeta(j.status).terminal))

  let pollTimer: ReturnType<typeof setTimeout> | null = null
  // Disposed once stopAutoPoll (unmount) runs. Guards the case where the component unmounts WHILE a
  // timer callback is mid-`await refresh()`: without it the finished callback would re-arm a timer on
  // the dead component.
  let disposed = false
  let pollFailures = 0 // consecutive failed polls → stop after MAX_POLL_FAILURES
  // The first successful `refresh()` of this instance. Until it happens we keep retrying on a backoff
  // even with nothing active — otherwise a single failed first load left the list empty forever.
  let firstLoadOk = false
  function clearTimer(): void {
    if (pollTimer) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
  }
  function stopAutoPoll(): void {
    disposed = true
    clearTimer()
  }
  // Arm the next poll if the pure rule says so (nextPollDelay): while a job is running, or until the
  // first load succeeds. Self-cancelling. Client-only (no window on SSG).
  function scheduleNext(): void {
    clearTimer()
    if (disposed || typeof window === 'undefined') return
    const delay = nextPollDelay({ firstLoadOk, hasActive: hasActive.value, failures: pollFailures })
    if (delay === null) return
    pollTimer = setTimeout(async () => {
      await refresh()
      // refresh() swallows errors into listError; count consecutive failures so a persistently dead
      // frame token stops the loop instead of polling forever.
      pollFailures = listError.value ? pollFailures + 1 : 0
      if (!disposed) scheduleNext() // nextPollDelay stops the loop once failures hit the cap
    }, delay)
  }

  async function headers(): Promise<Record<string, string> | null> {
    await init()
    return buildFrameHeaders(auth())
  }

  async function refresh(): Promise<void> {
    const h = await headers()
    if (!h) {
      listError.value = 'Импорт доступен только внутри портала Bitrix24'
      error.value = listError.value
      return
    }
    // The client owns the job list (localStorage) — poll status only for OUR jobIds. No server list.
    const store = typeof window !== 'undefined' ? window.localStorage : null
    const ids = store ? importJobIds(store) : []
    if (!ids.length) {
      jobs.value = []
      listError.value = ''
      firstLoadOk = true // an empty history IS a successful load — nothing to retry
      return
    }
    loading.value = true
    try {
      // POST: the id list rides in the body, not in the URL (#260) — it grows with the history cap and
      // would otherwise hit proxy header limits and leak job ids into access logs.
      const res = await $fetch<{ jobs: ImportJobView[], requested?: number, answered?: number }>(
        '/api/import/status',
        { method: 'POST', headers: h, body: { ids } }
      )
      // Merge: server gives the live status/result; localStorage gives the fileName we remembered
      // (and preserves display order = newest-first). A remembered row the server no longer knows
      // (its 48h status TTL ran out while the browser keeps 7 days) becomes an `expired` row rather
      // than disappearing — silently dropping it read as «истории нет» (#268).
      const local = store ? readHistory(store) : []
      jobs.value = mergeJobRows(local, res.jobs, { portal: auth()?.domain })
      // The server caps how many ids it answers for. It used to drop the excess silently — those rows
      // then just stopped updating, with no error anywhere (#260). Say it out loud instead. The counts
      // come FROM the server: only it knows how many ids survived validation.
      listWarning.value = truncationWarning(res.requested, res.answered)
      listError.value = ''
      firstLoadOk = true
    } catch (e) {
      listError.value = fetchErrorMessage(e, 'Не удалось получить статус импорта')
    } finally {
      loading.value = false
    }
  }

  async function upload(file: File, target?: TargetRef | null, jobId?: string): Promise<UploadOutcome> {
    const h = await headers()
    if (!h) {
      const msg = 'Импорт доступен только внутри портала Bitrix24'
      error.value = msg
      // Не про файл, а про то, где мы открыты: остальные строки упрутся в то же самое.
      return { ok: false, stop: true, message: msg }
    }
    uploading.value = true
    // A client-supplied jobId (stable per staged file) makes a retry idempotent AND lets us record the
    // job UP FRONT — so even if the response is lost after the server committed the job, it still shows
    // in «Последние операции» and is polled (no invisible import). addImportJob is keyed by jobId (idempotent).
    const clientJob = !!jobId && typeof window !== 'undefined'
    if (clientJob) addImportJob(window.localStorage, jobId!, file.name, Date.now(), auth()?.domain)
    try {
      const form = new FormData()
      form.append('file', file)
      // Optional manual target («куда импортировать») — overrides the routing rules for this job.
      // The server re-validates it (parseManualTarget); an absent/invalid one just follows the rules.
      if (target && target.entityTypeId > 0) form.append('target', JSON.stringify(target))
      if (jobId) form.append('jobId', jobId) // idempotency key (server validates it's a UUID)
      const res = await $fetch<{ jobId?: string }>('/api/import/upload', { method: 'POST', headers: h, body: form })
      // Remember this job in the browser (no-op if already recorded up-front). Client owns history now.
      if (!clientJob && typeof window !== 'undefined' && res?.jobId) addImportJob(window.localStorage, res.jobId, file.name, Date.now(), auth()?.domain)
      await refresh()
      scheduleNext() // the new job is queued → start following its progress
      return { ok: true, stop: false }
    } catch (e) {
      const msg = fetchErrorMessage(e, 'Загрузка не удалась — проверьте формат и размер файла')
      error.value = msg
      // The staging loop needs more than «не вышло»: on a rate-limit refusal it must stop the batch
      // and show the server's own wording (it says how long to wait), not «проверьте связь».
      return classifyUploadError(e, msg)
    } finally {
      uploading.value = false
    }
  }

  /** Initial load + start following in-flight jobs (call on mount). */
  async function startAutoPoll(): Promise<void> {
    disposed = false // in case this instance was previously stopped and is restarted
    pollFailures = 0
    firstLoadOk = false
    await refresh()
    scheduleNext()
  }

  /** Manual «Обновить» (button): refresh once and, on success, RESUME auto-following — a run of transient
   *  poll failures may have stopped the loop (MAX_POLL_FAILURES) while jobs are still in flight; a
   *  successful manual refresh clears the failure streak and re-arms polling so «обновляется» is honest. */
  async function refreshNow(): Promise<void> {
    // Reset the failure streak BEFORE re-arming: this button is the only way out once the loop has
    // given up (MAX_POLL_FAILURES), so it must restart it even when this attempt also failed — with
    // an unloaded list nextPollDelay then keeps retrying the first load on its backoff (#268).
    pollFailures = 0
    await refresh()
    scheduleNext()
  }

  /** Clear the employee's import history (localStorage) + the visible list. The server keeps only
   *  ephemeral per-job status (Redis TTL); this just forgets which jobIds the browser polls. */
  function clearHistory(): void {
    if (typeof window !== 'undefined') clearImportHistory(window.localStorage)
    jobs.value = []
  }

  /** Forget a SINGLE «Последние операции» row (localStorage + the visible list). Server keeps only
   *  ephemeral status; this just stops the browser polling/showing that jobId. */
  function removeJob(jobId: string): void {
    if (typeof window !== 'undefined') removeImportJob(window.localStorage, jobId)
    jobs.value = jobs.value.filter(j => j.jobId !== jobId)
  }

  return { jobs, loading, uploading, error, listError, listWarning, hasActive, refresh, refreshNow, upload, startAutoPoll, stopAutoPoll, clearHistory, removeJob }
}
