import { ref, computed } from 'vue'
import { useB24 } from './useB24'
import { buildFrameHeaders, fetchErrorMessage } from '~/utils/frameHeaders'
import { jobStatusMeta, type JobStatus } from '~/utils/jobStatus'
import { addImportJob, importJobIds, readHistory } from '~/utils/importHistory'
import type { TargetRef } from '~/types/mapping'

// In-portal import client: upload a document and poll job status via the frame-token
// authenticated API (/api/import/*). Inert outside a portal (no frame auth). Auto-polls the status
// while any job is still running (queued/extracting/processing) so the /app progress moves on its
// own, and stops once everything is terminal (done/error) — no idle polling.

export interface ImportJobView { jobId: string, status: JobStatus, fileName: string, result: string }

/** How often to re-poll status while a job is in flight. */
const POLL_MS = 2500
/** Stop auto-polling after this many CONSECUTIVE failed polls (e.g. a dead/expired frame token) so we
 *  don't hammer the endpoint forever; the user can still «Обновить» manually. */
const MAX_POLL_FAILURES = 5

export function useImport() {
  const { init, auth } = useB24()
  const jobs = ref<ImportJobView[]>([])
  const loading = ref(false)
  const uploading = ref(false)
  const error = ref('')

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
  // Schedule the next poll ONLY while there's an active job. Self-cancelling: when the last job goes
  // terminal, `hasActive` is false and no further timer is armed. Client-only (no window on SSG).
  function scheduleNext(): void {
    clearTimer()
    if (disposed || typeof window === 'undefined' || !hasActive.value) return
    pollTimer = setTimeout(async () => {
      await refresh()
      // refresh() swallows errors into error.value; count consecutive failures so a persistently
      // dead frame token stops the loop instead of polling forever.
      pollFailures = error.value ? pollFailures + 1 : 0
      if (!disposed && pollFailures < MAX_POLL_FAILURES) scheduleNext() // don't re-arm after unmount / too many fails
    }, POLL_MS)
  }

  async function headers(): Promise<Record<string, string> | null> {
    await init()
    return buildFrameHeaders(auth())
  }

  async function refresh(): Promise<void> {
    const h = await headers()
    if (!h) {
      error.value = 'Импорт доступен только внутри портала Bitrix24'
      return
    }
    // The client owns the job list (localStorage) — poll status only for OUR jobIds. No server list.
    const store = typeof window !== 'undefined' ? window.localStorage : null
    const ids = store ? importJobIds(store) : []
    if (!ids.length) {
      jobs.value = []
      error.value = ''
      return
    }
    loading.value = true
    try {
      const res = await $fetch<{ jobs: ImportJobView[] }>('/api/import/status', { headers: h, query: { ids: ids.join(',') } })
      // Merge: server gives the live status/result; localStorage gives the fileName we remembered
      // (and preserves display order = newest-first). Jobs whose server status expired just drop off.
      const local = store ? readHistory(store) : []
      const byId = new Map(res.jobs.map(j => [j.jobId, j]))
      jobs.value = local
        .filter(e => byId.has(e.jobId))
        .map((e) => {
          const j = byId.get(e.jobId)!
          return { jobId: j.jobId, status: j.status, fileName: e.fileName || j.fileName, result: j.result }
        })
      error.value = ''
    } catch (e) {
      error.value = fetchErrorMessage(e, 'Не удалось получить статус импорта')
    } finally {
      loading.value = false
    }
  }

  async function upload(file: File, target?: TargetRef | null): Promise<boolean> {
    const h = await headers()
    if (!h) {
      error.value = 'Импорт доступен только внутри портала Bitrix24'
      return false
    }
    uploading.value = true
    try {
      const form = new FormData()
      form.append('file', file)
      // Optional manual target («куда импортировать») — overrides the routing rules for this job.
      // The server re-validates it (parseManualTarget); an absent/invalid one just follows the rules.
      if (target && target.entityTypeId > 0) form.append('target', JSON.stringify(target))
      const res = await $fetch<{ jobId?: string }>('/api/import/upload', { method: 'POST', headers: h, body: form })
      // Remember this job in the browser (it's the client's own history now — no server list).
      if (typeof window !== 'undefined' && res?.jobId) addImportJob(window.localStorage, res.jobId, file.name)
      await refresh()
      scheduleNext() // the new job is queued → start following its progress
      return true
    } catch (e) {
      error.value = fetchErrorMessage(e, 'Загрузка не удалась — проверьте формат и размер файла')
      return false
    } finally {
      uploading.value = false
    }
  }

  /** Initial load + start following in-flight jobs (call on mount). */
  async function startAutoPoll(): Promise<void> {
    disposed = false // in case this instance was previously stopped and is restarted
    pollFailures = 0
    await refresh()
    scheduleNext()
  }

  return { jobs, loading, uploading, error, hasActive, refresh, upload, startAutoPoll, stopAutoPoll }
}
