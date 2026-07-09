import { ref } from 'vue'
import { useB24 } from './useB24'
import { buildFrameHeaders, fetchErrorMessage } from '~/utils/frameHeaders'
import { defaultMapping } from '~/utils/portalSettings'
import type { PortalMapping } from '~/types/mapping'

// In-portal settings client: load/save the portal mapping via the frame-token
// authenticated /api/settings (GET/POST). Inert outside a portal (no frame auth).

export function useSettings() {
  const { init, auth } = useB24()
  const mapping = ref<PortalMapping>(defaultMapping())
  const loading = ref(false)
  const saving = ref(false)
  const saved = ref(false)
  const error = ref('')

  async function headers(): Promise<Record<string, string> | null> {
    await init()
    return buildFrameHeaders(auth())
  }

  async function load(): Promise<void> {
    const h = await headers()
    if (!h) {
      error.value = 'Настройки доступны только внутри портала Bitrix24'
      return
    }
    loading.value = true
    try {
      const res = await $fetch<{ mapping: PortalMapping }>('/api/settings', { headers: h })
      mapping.value = res.mapping
      error.value = ''
    } catch (e) {
      error.value = fetchErrorMessage(e, 'Не удалось загрузить настройки')
    } finally {
      loading.value = false
    }
  }

  async function save(): Promise<void> {
    const h = await headers()
    if (!h) {
      error.value = 'Настройки доступны только внутри портала Bitrix24'
      return
    }
    saving.value = true
    saved.value = false
    try {
      const res = await $fetch<{ mapping: PortalMapping }>('/api/settings', { method: 'POST', headers: h, body: { mapping: mapping.value } })
      mapping.value = res.mapping
      saved.value = true
      error.value = ''
    } catch (e) {
      error.value = fetchErrorMessage(e, 'Не удалось сохранить настройки')
    } finally {
      saving.value = false
    }
  }

  return { mapping, loading, saving, saved, error, load, save }
}
