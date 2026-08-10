import { ref, computed } from 'vue'
import { useB24 } from './useB24'
import { buildFrameHeaders, fetchErrorMessage, frameAuthMessage } from '~/utils/frameHeaders'
import { jobStatusMeta, type JobStatus } from '~/utils/jobStatus'
import { nextPollDelay } from '~/utils/pollBackoff'
import { truncationWarning } from '~~/server/utils/importStatusIds'
import { classifyUploadError, type UploadOutcome } from '~/utils/importUpload'
import type { TargetRef } from '~/types/mapping'

// In-portal import client: upload documents and poll job status via the frame-token authenticated
// API (/api/import/*). Inert outside a portal (no frame auth). Auto-polls while any job is still
// running (queued/extracting/processing) and stops once everything is terminal — no idle polling.
//
// THE JOB LIST LIVES IN PAGE MEMORY ONLY (owner rework). localStorage held a 7-day history of jobIds
// per employee; the owner dropped it: nothing is written to localStorage any more, so the list shows
// exactly the imports of THIS open page and dies with it. That is why the import run warns «не
// закрывайте страницу» — a closed tab loses the only mapping from jobId to file name. The server
// keeps only ephemeral per-job status (Redis TTL) and never a per-portal list.

export interface ImportJobView {
  jobId: string
  status: JobStatus
  fileName: string
  result: string
  /** CRM type the employee chose for this file, when they chose one manually (#269). */
  targetEntityTypeId?: number
  /** When this page started tracking the job — grace window for the expired-detection below. */
  trackedAt?: number
}

/** How long an id may stay unknown to the server before we call it lost. Covers the race where a
 *  poll fires between track() and the upload POST landing (the server writes the job record inside
 *  that POST) — seconds in practice; a minute is comfortably outside it. */
const EXPIRE_UNKNOWN_AFTER_MS = 60_000

// ⚠ ПАМЯТИ ФАЙЛОВ ЗДЕСЬ БОЛЬШЕ НЕТ (#461). Страница держала байты каждого импорта, чтобы виджет
// отзыва мог их приложить (#349) — до 60 МБ на вкладку, — и всё равно теряла их при перезагрузке.
// Теперь документ приложен к делу таймлайна, и сервер читает его оттуда сам: страница о файле
// после отправки не знает ничего, и знать ей незачем.

export function useImport() {
  const { init, ensureAuth, inFrame } = useB24()
  const jobs = ref<ImportJobView[]>([])
  const loading = ref(false)
  const uploading = ref(false)
  const error = ref('')
  // Separate from `error`, which is shared with upload() and «вне портала». Only set by refresh(), so
  // the list can say «статус получить не удалось» without claiming that after a failed UPLOAD.
  const listError = ref('')
  // A SUCCESSFUL poll that couldn't cover every tracked job. Deliberately NOT `listError`: that one
  // feeds the failure streak in scheduleNext, so a warning there would stop auto-polling after five
  // successful-but-truncated answers — exactly for the page with the most jobs (#260).
  const listWarning = ref('')

  // Any job not yet in a terminal state → keep polling.
  const hasActive = computed(() => jobs.value.some(j => !jobStatusMeta(j.status).terminal))

  let pollTimer: ReturnType<typeof setTimeout> | null = null
  // Disposed once stopAutoPoll (unmount) runs. Guards the case where the component unmounts WHILE a
  // timer callback is mid-`await refresh()`: without it the finished callback would re-arm a timer on
  // the dead component.
  let disposed = false
  let pollFailures = 0 // consecutive failed polls → stop after MAX_POLL_FAILURES
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
  // Arm the next poll if the pure rule says so (nextPollDelay). Self-cancelling. Client-only (no
  // window on SSG). `firstLoadOk: true` — with no persisted history there is nothing to «first-load»:
  // an empty in-memory list needs no retry loop, polling starts when the first upload adds a job.
  function scheduleNext(): void {
    clearTimer()
    if (disposed || typeof window === 'undefined') return
    const delay = nextPollDelay({ firstLoadOk: true, hasActive: hasActive.value, failures: pollFailures })
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
    return buildFrameHeaders(await ensureAuth())
  }

  async function refresh(): Promise<void> {
    const ids = jobs.value.map(j => j.jobId)
    if (!ids.length) {
      listError.value = ''
      return
    }
    const h = await headers()
    if (!h) {
      listError.value = frameAuthMessage(inFrame(), 'Импорт доступен')
      error.value = listError.value
      return
    }
    loading.value = true
    try {
      // POST: the id list rides in the body, not in the URL (#260) — it would otherwise hit proxy
      // header limits and leak job ids into access logs.
      const res = await $fetch<{ jobs: ImportJobView[], requested?: number, answered?: number }>(
        '/api/import/status',
        { method: 'POST', headers: h, body: { ids } }
      )
      // Merge the server's live status INTO the in-memory rows. The page owns the row identity and
      // the file name (the server response may omit or shorten it); the server owns status/result.
      // An id the server no longer knows keeps its last in-memory state — with the list living only
      // as long as the page, that means a Redis-side loss, not a stale 7-day history entry.
      const byId = new Map(res.jobs.map(j => [j.jobId, j]))
      jobs.value = jobs.value.map((row) => {
        const live = byId.get(row.jobId)
        if (live) return { ...live, fileName: row.fileName || live.fileName, trackedAt: row.trackedAt }
        // The server does not know this id. Right after track() that is a benign race (the upload
        // POST has not landed yet) — but past the grace window it means the job is GONE (Redis loss,
        // TTL). Left as-is the row would poll forever: a terminal `expired` stops the loop and the
        // row says honestly that the status was lost.
        const age = Date.now() - (row.trackedAt ?? 0)
        return age > EXPIRE_UNKNOWN_AFTER_MS && !jobStatusMeta(row.status).terminal
          ? { ...row, status: 'expired' as JobStatus }
          : row
      })
      // The server caps how many ids it answers for; say it out loud instead of dropping rows (#260).
      listWarning.value = truncationWarning(res.requested, res.answered)
      listError.value = ''
    } catch (e) {
      listError.value = fetchErrorMessage(e, 'Не удалось получить статус импорта')
    } finally {
      loading.value = false
    }
  }

  async function upload(file: File, target?: TargetRef | null, jobId?: string): Promise<UploadOutcome> {
    const h = await headers()
    if (!h) {
      const msg = frameAuthMessage(inFrame(), 'Импорт доступен')
      error.value = msg
      // Не про файл, а про то, где мы открыты: остальные строки упрутся в то же самое.
      return { ok: false, stop: true, message: msg }
    }
    uploading.value = true
    // A client-supplied jobId (stable per staged file) makes a retry idempotent AND lets us record the
    // job UP FRONT — so even if the response is lost after the server committed the job, it still shows
    // in the list and is polled (no invisible import). Recording is keyed by jobId (idempotent).
    if (jobId) track(jobId, file.name, target)
    try {
      const form = new FormData()
      form.append('file', file)
      // Optional manual target («куда импортировать») — overrides the routing rules for this job.
      // The server re-validates it (parseManualTarget); an absent/invalid one just follows the rules.
      if (target && target.entityTypeId > 0) form.append('target', JSON.stringify(target))
      if (jobId) form.append('jobId', jobId) // idempotency key (server validates it's a UUID)
      const res = await $fetch<{ jobId?: string }>('/api/import/upload', { method: 'POST', headers: h, body: form })
      if (!jobId && res?.jobId) track(res.jobId, file.name, target)
      await refresh()
      scheduleNext() // the new job is queued → start following its progress
      return { ok: true, stop: false }
    } catch (e) {
      const msg = fetchErrorMessage(e, 'Загрузка не удалась — проверьте формат и размер файла')
      error.value = msg
      // The row was pre-tracked BEFORE the POST (so a response lost after the server committed still
      // shows). But a DEFINITE rejection (an HTTP status came back: 400/413/429…) means the server
      // never created the job — keeping the row would leave a phantom «В очереди» polling forever.
      // A network error (no status) keeps it: the server may well have committed.
      const status = e as { statusCode?: number, status?: number, response?: { status?: number } }
      const code = status?.statusCode ?? status?.status ?? status?.response?.status
      if (jobId && typeof code === 'number' && code >= 400) dropJob(jobId)
      // The staging loop needs more than «не вышло»: on a rate-limit refusal it must stop the batch
      // and show the server's own wording (it says how long to wait), not «проверьте связь».
      return classifyUploadError(e, msg)
    } finally {
      uploading.value = false
    }
  }

  /**
   * Убрать строку из ленты — ВНУТРЕННЕЕ, наружу не отдаётся.
   *
   * ⚠ Единственное применение: фантомная строка после ОПРЕДЕЛЁННОГО отказа загрузки (сервер ответил
   * кодом — задания не существует). Наружу этой ручки больше нет (решение владельца 10.08.2026):
   * крестик у строки и «Очистить список» убраны, историю смотрят в журнале. Это же закрывает #479 —
   * ключ ожидания мог зависнуть навсегда только если строку убрали из списка, а отказавшая загрузка
   * в ожидание и не попадает: туда идут только принятые сервером задания.
   */
  function dropJob(jobId: string): void {
    jobs.value = jobs.value.filter(j => j.jobId !== jobId)
  }

  /** Add a job row to the in-memory list (newest first). Idempotent by jobId — a retried upload of
   *  the same staged file must not produce a second row. */
  function track(jobId: string, fileName: string, target?: TargetRef | null): void {
    if (jobs.value.some(j => j.jobId === jobId)) return
    jobs.value = [{
      jobId,
      status: 'queued',
      fileName,
      result: '',
      trackedAt: Date.now(),
      ...(target && target.entityTypeId > 0 ? { targetEntityTypeId: target.entityTypeId } : {})
    }, ...jobs.value]
  }

  /** Terminal status of a tracked job, or null while it is still running / unknown. Used by the
   *  staging list to decide when the whole batch is finished. */
  function jobDone(jobId: string): JobStatus | null {
    const j = jobs.value.find(x => x.jobId === jobId)
    if (!j) return null
    return jobStatusMeta(j.status).terminal ? j.status : null
  }

  /** Start following in-flight jobs (call on mount). With no persisted history the initial list is
   *  always empty — this only arms the polling loop for uploads made on this page. */
  async function startAutoPoll(): Promise<void> {
    disposed = false // in case this instance was previously stopped and is restarted
    pollFailures = 0
    scheduleNext()
  }

  /** Manual «Обновить» (button): refresh once and, on success, RESUME auto-following — a run of transient
   *  poll failures may have stopped the loop (MAX_POLL_FAILURES) while jobs are still in flight; a
   *  successful manual refresh clears the failure streak and re-arms polling so «обновляется» is honest. */
  async function refreshNow(): Promise<void> {
    pollFailures = 0
    await refresh()
    scheduleNext()
  }

  return { jobs, loading, uploading, error, listError, listWarning, hasActive, refresh, refreshNow, upload, track, jobDone, startAutoPoll, stopAutoPoll }
}
