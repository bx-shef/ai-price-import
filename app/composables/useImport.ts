import { ref } from 'vue'
import { useB24 } from './useB24'
import { buildFrameHeaders, fetchErrorMessage } from '~/utils/frameHeaders'
import type { JobStatus } from '~/utils/jobStatus'

// In-portal import client: upload a document and poll job status via the frame-token
// authenticated API (/api/import/*). Inert outside a portal (no frame auth).

export interface ImportJobView { jobId: string, status: JobStatus, fileName: string, result: string }

export function useImport() {
  const { init, auth } = useB24()
  const jobs = ref<ImportJobView[]>([])
  const loading = ref(false)
  const uploading = ref(false)
  const error = ref('')

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

  async function upload(file: File): Promise<boolean> {
    const h = await headers()
    if (!h) {
      error.value = 'Импорт доступен только внутри портала Bitrix24'
      return false
    }
    uploading.value = true
    try {
      const form = new FormData()
      form.append('file', file)
      await $fetch('/api/import/upload', { method: 'POST', headers: h, body: form })
      await refresh()
      return true
    } catch (e) {
      error.value = fetchErrorMessage(e, 'Загрузка не удалась — проверьте формат и размер файла')
      return false
    } finally {
      uploading.value = false
    }
  }

  return { jobs, loading, uploading, error, refresh, upload }
}
