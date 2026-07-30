import { onScopeDispose, ref } from 'vue'
import { failureStatus, isDisabledByServer, isThrottled, loginErrorMessage, retryAfterSeconds } from '~/utils/loginError'

// Operator auth client (service zone: /queues). Talks to /api/auth/*. The real gate
// is server-side (routes return 401/503); this drives the UI + redirects.

export function useAuth() {
  const authenticated = ref(false)
  const enabled = ref(true)
  const checking = ref(false)
  const error = ref('')
  // Сработала защита от перебора. Блокировка ВРЕМЕННАЯ и снимается сама: за nginx окно около шести
  // секунд, и глушить форму до перезагрузки страницы из-за него — хуже исходной беды. Секунды
  // тикают вниз, чтобы человек видел, что ожидание конечно.
  const retryIn = ref(0)
  let retryTimer: ReturnType<typeof setInterval> | undefined

  function stopRetryCountdown(): void {
    if (retryTimer) clearInterval(retryTimer)
    retryTimer = undefined
  }

  function startRetryCountdown(seconds: number): void {
    stopRetryCountdown()
    retryIn.value = seconds
    retryTimer = setInterval(() => {
      retryIn.value -= 1
      if (retryIn.value <= 0) stopRetryCountdown()
    }, 1000)
  }

  // Страницу могут закрыть с активным отсчётом — таймер за собой убираем.
  onScopeDispose(stopRetryCountdown)

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
    try {
      await $fetch('/api/auth/login', { method: 'POST', body: { password } })
      authenticated.value = true
      return true
    } catch (e) {
      // Смысл несёт статус, а не текст: 401 / 429 / 503 — три разные ситуации, которые раньше
      // выглядели одинаково («Не удалось войти»). Разбор — в чистом loginErrorMessage.
      const err = e as { data?: { error?: string }, response?: { headers?: { get?: (k: string) => string | null } } }
      const status = failureStatus(e)
      const raw = Number(err?.response?.headers?.get?.('retry-after'))
      const header = Number.isFinite(raw) ? raw : null
      error.value = loginErrorMessage({ status, serverMessage: err?.data?.error, retryAfterSec: header })
      if (isThrottled(status)) startRetryCountdown(retryAfterSeconds(header))
      // Пароль могли убрать на сервере уже после открытия страницы: тогда `enabled` из проверки
      // сессии устарел, и форма продолжала бы приглашать к бесполезной попытке.
      if (isDisabledByServer(status)) enabled.value = false
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

  return { authenticated, enabled, checking, error, retryIn, check, login, logout }
}
