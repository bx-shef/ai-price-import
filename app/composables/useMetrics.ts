import { ref } from 'vue'
import { useB24 } from './useB24'
import { buildFrameHeaders, fetchErrorMessage } from '~/utils/frameHeaders'
import type { MoneyBlocker, Savings } from '~/utils/savings'

// In-portal metrics client: read the per-portal dashboard counters + time/money-saved
// estimate, and reset them. Frame-token authenticated (member-scoped on the server).
// Inert outside a portal (no frame auth). Mirrors useImport.

export interface MetricsView { counters: Record<string, number>, savings: Savings, moneyBlocker?: MoneyBlocker | null }

export function useMetrics() {
  const { init, ensureAuth } = useB24()
  const counters = ref<Record<string, number>>({})
  const savings = ref<Savings | null>(null)
  // Why there is no money tile (server-decided) — so the dashboard can say it instead of
  // showing nothing and leaving the admin to guess.
  const moneyBlocker = ref<MoneyBlocker | null>(null)
  const loading = ref(false)
  const resetting = ref(false)
  const error = ref('')

  async function headers(): Promise<Record<string, string> | null> {
    await init()
    return buildFrameHeaders(await ensureAuth())
  }

  async function load(): Promise<void> {
    const h = await headers()
    if (!h) return // outside a portal: stay graceful (panel shows zeros, no error surfaced)
    loading.value = true
    try {
      const res = await $fetch<MetricsView>('/api/import/metrics', { headers: h })
      counters.value = res.counters
      savings.value = res.savings
      moneyBlocker.value = res.moneyBlocker ?? null
      error.value = ''
    } catch (e) {
      error.value = fetchErrorMessage(e, 'Не удалось получить метрики')
    } finally {
      loading.value = false
    }
  }

  /** Reset the portal's counters (operator action), then reload. Returns success. */
  async function reset(): Promise<boolean> {
    const h = await headers()
    if (!h) return false
    resetting.value = true
    try {
      await $fetch('/api/import/metrics-reset', { method: 'POST', headers: h })
      await load()
      return true
    } catch (e) {
      error.value = fetchErrorMessage(e, 'Не удалось сбросить метрики')
      return false
    } finally {
      resetting.value = false
    }
  }

  return { counters, savings, moneyBlocker, loading, resetting, error, load, reset }
}
