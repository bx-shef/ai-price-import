import { ref } from 'vue'
import { useB24 } from './useB24'
import { buildFrameHeaders, fetchErrorMessage } from '~/utils/frameHeaders'
import { defaultMapping } from '~/utils/portalSettings'
import { createDebouncer } from '~/utils/debounce'
import { shouldAutosave } from '~/utils/autosave'
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
    // Serialize saves: if one is already in flight, re-arm the debounce and bail. Overlapping POSTs
    // would race, and an older response reseeding `mapping` could clobber a newer edit (lost update).
    if (saving.value) {
      debouncer.schedule()
      return
    }
    debouncer.cancel() // a manual/flushed save subsumes any pending autosave — don't double-POST
    // Snapshot what we're about to send BEFORE the await, so we can tell whether the user edited
    // during the round-trip.
    const sentJson = snapshot()
    saving.value = true
    saved.value = false
    try {
      const res = await $fetch<{ mapping: PortalMapping }>('/api/settings', { method: 'POST', headers: h, body: { mapping: mapping.value } })
      if (snapshot() === sentJson) {
        // Untouched since we sent it → safe to reflect the server's normalized form. Baseline on the
        // RESEEDED value (server key order) so the echo guard matches exactly — no redundant re-POST.
        mapping.value = res.mapping
        lastSavedJson = snapshot()
        saved.value = true
      } else {
        // The user edited during the round-trip. Do NOT reseed (that would clobber the newer edit).
        // We persisted `sentJson`; the newer content stays "dirty" → arm autosave to persist it too.
        lastSavedJson = sentJson
        scheduleSave()
      }
      error.value = ''
    } catch (e) {
      error.value = fetchErrorMessage(e, 'Не удалось сохранить настройки')
    } finally {
      saving.value = false
    }
  }

  /** Arm autosave after an edit. No-op before the first load, or when nothing changed (echo guard). */
  function scheduleSave(): void {
    if (!shouldAutosave(snapshot(), lastSavedJson, ready.value)) return
    saved.value = false
    debouncer.schedule()
  }

  /** Run a pending autosave immediately (explicit «Сохранить» button / component unmount). */
  function flushSave(): void {
    debouncer.flush()
  }

  /** Re-baseline the echo guard to the CURRENT mapping (nothing pending to save). The component
   *  calls this once after the open-time category/stage reconciles settle, so their normalization
   *  of the loaded mapping isn't mistaken for a user edit and doesn't autosave on open. */
  function rebaseline(): void {
    lastSavedJson = snapshot()
  }

  return { mapping, loading, saving, saved, error, load, save, scheduleSave, flushSave, rebaseline }
}
