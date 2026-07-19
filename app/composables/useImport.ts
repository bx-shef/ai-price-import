import { ref, computed } from 'vue'
import { useB24 } from './useB24'
import { buildFrameHeaders, fetchErrorMessage } from '~/utils/frameHeaders'
import { jobStatusMeta, type JobStatus } from '~/utils/jobStatus'
import type { TargetRef } from '~/types/mapping'

// In-portal import client: upload a document and poll job status via the frame-token
// authenticated API (/api/import/*). Inert outside a portal (no frame auth). Auto-polls the status
// while any job is still running (queued/extracting/processing) so the /app progress moves on its
// own, and stops once everything is terminal (done/error) — no idle polling.

export interface ImportJobView { jobId: string, status: JobStatus, fileName: string, result: string }

/** How often to re-poll status while a job is in flight. */
const POLL_MS = 2500

export function useImport() {
  const { init, auth } = useB24()
  const jobs = ref<ImportJobView[]>([])
  const loading = ref(false)
  const uploading = ref(false)
  const error = ref('')

  // Any job not yet in a terminal state → keep polling.
  const hasActive = computed(() => jobs.value.some(j => !jobStatusMeta(j.status).terminal))

  let pollTimer: ReturnType<typeof setTimeout> | null = null
  function stopAutoPoll(): void {
    if (pollTimer) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
  }
  // Schedule the next poll ONLY while there's an active job. Self-cancelling: when the last job goes
  // terminal, `hasActive` is false and no further timer is armed. Client-only (no window on SSG).
  function scheduleNext(): void {
    stopAutoPoll()
    if (typeof window === 'undefined' || !hasActive.value) return
    pollTimer = setTimeout(async () => {
      await refresh()
      scheduleNext()
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
    loading.value = true
    try {
      const res = await $fetch<{ jobs: ImportJobView[] }>('/api/import/status', { headers: h })
      jobs.value = res.jobs
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
      await $fetch('/api/import/upload', { method: 'POST', headers: h, body: form })
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
    await refresh()
    scheduleNext()
  }

  return { jobs, loading, uploading, error, hasActive, refresh, upload, startAutoPoll, stopAutoPoll }
}
