import { ref } from 'vue'
import { isLockedOut, loginErrorMessage } from '~/utils/loginError'

// Operator auth client (service zone: /queues). Talks to /api/auth/*. The real gate
// is server-side (routes return 401/503); this drives the UI + redirects.

export function useAuth() {
  const authenticated = ref(false)
  const enabled = ref(true)
  const checking = ref(false)
  const error = ref('')
  // Сработала защита от перебора: форму держим неактивной, иначе каждая новая попытка только
  // продлевает окно ожидания, а человек этого не видит.
  const lockedOut = ref(false)

  async function check(): Promise<void> {
    checking.value = true
    try {
      const r = await $fetch<{ authenticated: boolean, enabled: boolean }>('/api/auth/session')
      authenticated.value = r.authenticated
      enabled.value = r.enabled
    } catch {
      authenticated.value = false
    } finally {
      checking.value = false
    }
  }

  async function login(password: string): Promise<boolean> {
    error.value = ''
    lockedOut.value = false
    try {
      await $fetch('/api/auth/login', { method: 'POST', body: { password } })
      authenticated.value = true
      return true
    } catch (e) {
      // Смысл несёт статус, а не текст: 401 / 429 / 503 — три разные ситуации, которые раньше
      // выглядели одинаково («Не удалось войти»). Разбор — в чистом loginErrorMessage.
      const err = e as { statusCode?: number, data?: { error?: string }, response?: { headers?: { get?: (k: string) => string | null } } }
      const retryAfter = Number(err?.response?.headers?.get?.('retry-after'))
      error.value = loginErrorMessage({
        status: err?.statusCode,
        serverMessage: err?.data?.error,
        retryAfterSec: Number.isFinite(retryAfter) ? retryAfter : null
      })
      lockedOut.value = isLockedOut(err?.statusCode)
      return false
    }
  }

  async function logout(): Promise<void> {
    try {
      await $fetch('/api/auth/logout', { method: 'POST' })
    } finally {
      authenticated.value = false
    }
  }

  return { authenticated, enabled, checking, error, lockedOut, check, login, logout }
}
