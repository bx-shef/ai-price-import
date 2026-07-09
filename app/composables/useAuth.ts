import { ref } from 'vue'

// Operator auth client (service zone: /queues). Talks to /api/auth/*. The real gate
// is server-side (routes return 401/503); this drives the UI + redirects.

export function useAuth() {
  const authenticated = ref(false)
  const enabled = ref(true)
  const checking = ref(false)
  const error = ref('')

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
      error.value = (e as { data?: { error?: string } })?.data?.error || 'Не удалось войти'
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

  return { authenticated, enabled, checking, error, check, login, logout }
}
