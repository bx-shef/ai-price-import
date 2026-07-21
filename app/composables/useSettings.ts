import { ref } from 'vue'
import { useB24 } from './useB24'
import { buildFrameHeaders, fetchErrorMessage } from '~/utils/frameHeaders'
import { defaultMapping } from '~/utils/portalSettings'
import type { PortalMapping } from '~/types/mapping'

// In-portal settings client: load/save the portal mapping via the frame-token authenticated
// /api/settings (GET/POST). Inert outside a portal (no frame auth). Saving is EXPLICIT (the settings
// form has Save/Cancel — no autosave). The `sentJson` snapshot exists only to guard against a lost
// update: if the user edits DURING a save round-trip, the server's normalized response is not reseeded
// over the newer edit.

export function useSettings() {
  const { init, auth } = useB24()
  const mapping = ref<PortalMapping>(defaultMapping())
  const loading = ref(false)
  const saving = ref(false)
  const saved = ref(false)
  const error = ref('')
  // Whether the CALLING portal user is an admin (from GET /api/settings, verified server-side).
  // Non-admins may view settings but not save — writes are also enforced admin-only on the server.
  const isAdmin = ref(false)
  const snapshot = (): string => JSON.stringify(mapping.value)

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
      const res = await $fetch<{ mapping: PortalMapping, admin?: boolean }>('/api/settings', { headers: h })
      mapping.value = res.mapping
      isAdmin.value = res.admin === true
      saved.value = false
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
    if (!isAdmin.value) {
      // The server enforces this too (403); block client-side so we don't spam a doomed POST.
      error.value = 'Сохранять настройки может только администратор портала'
      return
    }
    if (saving.value) return // guard a double Save (the button is also disabled while saving)
    // Snapshot what we're about to send BEFORE the await, so we can tell whether the user edited
    // during the round-trip.
    const sentJson = snapshot()
    saving.value = true
    saved.value = false
    try {
      const res = await $fetch<{ mapping: PortalMapping }>('/api/settings', { method: 'POST', headers: h, body: { mapping: mapping.value } })
      if (snapshot() === sentJson) {
        // Untouched since we sent it → safe to reflect the server's normalized form.
        mapping.value = res.mapping
      } else {
        // The user edited during the round-trip. Do NOT reseed (that would clobber the newer edit);
        // we persisted `sentJson`, the newer content stays for the next explicit Save.
      }
      saved.value = true
      error.value = ''
    } catch (e) {
      error.value = fetchErrorMessage(e, 'Не удалось сохранить настройки')
    } finally {
      saving.value = false
    }
  }

  return { mapping, loading, saving, saved, error, isAdmin, load, save }
}
