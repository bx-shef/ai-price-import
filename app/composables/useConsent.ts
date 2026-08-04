import { ref } from 'vue'
import { useB24 } from './useB24'
import { buildFrameHeaders, fetchErrorMessage } from '~/utils/frameHeaders'
import type { LegalEdition } from '~/utils/legalEdition'

// Состояние принятия документов порталом (#414). Тонкая обёртка над `/api/consent`: решение живёт
// на сервере, здесь только показ и отправка.

export interface ConsentEditions { eula: LegalEdition, privacy: LegalEdition }

export function useConsent() {
  const { init, ensureAuth } = useB24()
  const accepted = ref(false)
  const admin = ref(false)
  const editions = ref<ConsentEditions | null>(null)
  const resolved = ref(false)
  const saving = ref(false)
  const error = ref('')

  async function headers(): Promise<Record<string, string> | null> {
    await init()
    return buildFrameHeaders(await ensureAuth())
  }

  async function load(): Promise<void> {
    try {
      const h = await headers()
      if (!h) return // вне портала — экран согласия неприменим, там и импорта нет
      const res = await $fetch<{ accepted: boolean, admin: boolean, editions: ConsentEditions }>('/api/consent', { headers: h })
      accepted.value = res.accepted === true
      admin.value = res.admin === true
      editions.value = res.editions ?? null
    } catch (e: unknown) {
      // ⚠ Отказ чтения НЕ читается как «согласие есть»: `accepted` остаётся false и экран согласия
      // остаётся на месте. Сервер всё равно не примет ни одного документа, поэтому пустить к работе
      // значило бы дать интерфейсу пообещать то, чего он не выполнит.
      error.value = fetchErrorMessage(e, 'Не удалось проверить принятие условий')
    } finally {
      resolved.value = true
    }
  }

  async function accept(): Promise<boolean> {
    saving.value = true
    error.value = ''
    try {
      const h = await headers()
      if (!h) {
        error.value = 'Подтвердить условия можно только внутри портала Битрикс24.'
        return false
      }
      await $fetch('/api/consent', { method: 'POST', headers: h })
      accepted.value = true
      return true
    } catch (e: unknown) {
      error.value = fetchErrorMessage(e, 'Не удалось сохранить подтверждение')
      return false
    } finally {
      saving.value = false
    }
  }

  return { accepted, admin, editions, resolved, saving, error, load, accept }
}
