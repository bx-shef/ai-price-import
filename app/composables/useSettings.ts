import { ref } from 'vue'
import { useB24 } from './useB24'
import { buildFrameHeaders, fetchErrorMessage } from '~/utils/frameHeaders'
import { defaultMapping } from '~/utils/portalSettings'
import { createDebouncer } from '~/utils/debounce'
import type { PortalMapping } from '~/types/mapping'

// In-portal settings client: load/save the portal mapping via the frame-token
// authenticated /api/settings (GET/POST). Inert outside a portal (no frame auth).
// Autosave: the component deep-watches `mapping` and calls `scheduleSave()`; a debounce coalesces a
// burst of edits into one POST. A content snapshot (`lastSavedJson`) suppresses the ECHO — the deep
// watch also fires when load/save reseeds `mapping` from the server response, and without the guard
// that would loop (reseed → watch → save → reseed → …). `flushSave()` (unmount / explicit button)
// runs a pending save now.

/** Debounce window for autosave — long enough to coalesce typing, short enough to feel live. */
const AUTOSAVE_DELAY_MS = 800

export function useSettings() {
  const { init, auth } = useB24()
  const mapping = ref<PortalMapping>(defaultMapping())
  const loading = ref(false)
  const saving = ref(false)
  const saved = ref(false)
  const error = ref('')
  // Autosave gates: `ready` (don't autosave before the first load) + `lastSavedJson` (echo guard).
  const ready = ref(false)
  let lastSavedJson = ''
  const snapshot = (): string => JSON.stringify(mapping.value)

  // Autosave debouncer. Declared before save() (which cancels it) — the arrow captures the hoisted
  // save() lazily, so referencing it here is safe.
  const debouncer = createDebouncer(() => void save(), AUTOSAVE_DELAY_MS)

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
      lastSavedJson = snapshot() // baseline: nothing to autosave until the user actually edits
      ready.value = true
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
    debouncer.cancel() // a manual/flushed save subsumes any pending autosave — don't double-POST
    // Serialize what we're about to send BEFORE the await, so edits made during the round-trip
    // aren't wrongly marked as saved (they'll re-trigger autosave against the new snapshot).
    const sentJson = snapshot()
    saving.value = true
    saved.value = false
    try {
      const res = await $fetch<{ mapping: PortalMapping }>('/api/settings', { method: 'POST', headers: h, body: { mapping: mapping.value } })
      mapping.value = res.mapping
      // Baseline is the SENT content, not the reseeded one: if the server normalized a field the
      // reseed differs → autosave picks it up once more (converges), never loops on identical data.
      lastSavedJson = sentJson
      saved.value = true
      error.value = ''
    } catch (e) {
      error.value = fetchErrorMessage(e, 'Не удалось сохранить настройки')
    } finally {
      saving.value = false
    }
  }

  /** Arm autosave after an edit. No-op before the first load, or when nothing changed (echo guard). */
  function scheduleSave(): void {
    if (!ready.value) return
    if (snapshot() === lastSavedJson) return // reseed echo / no net change — don't POST
    saved.value = false
    debouncer.schedule()
  }

  /** Run a pending autosave immediately (explicit «Сохранить» button / component unmount). */
  function flushSave(): void {
    debouncer.flush()
  }

  return { mapping, loading, saving, saved, error, load, save, scheduleSave, flushSave }
}
