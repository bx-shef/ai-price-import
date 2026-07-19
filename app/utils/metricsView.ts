// Pure presentation of the per-portal metric counters (metricsStore) for the UI: the always-on
// motivating figures on /app and the detailed /metrics view. Pure — data comes from the API.
// Reader (UI) and writer (crm-sync) share the counter vocabulary via server/utils/metricsStore.

export interface MetricRow {
  key: string
  /** Russian label for the operator. */
  label: string
  value: number
}

export interface MetricsSummary {
  rows: MetricRow[]
  /** created / docs, 0..1; null when nothing processed yet (avoid a fake 0%/NaN). */
  successRate: number | null
  /** True when every counter is zero (UI shows an empty state, not «0 из 0»). */
  empty: boolean
}

/** Display order + Russian labels. Unknown/extra counters are ignored (writer owns the set). */
const METRIC_LABELS: Array<{ key: string, label: string }> = [
  { key: 'docs', label: 'Документов обработано' },
  { key: 'created', label: 'Создано в CRM' },
  { key: 'lines', label: 'Позиций внесено' },
  { key: 'unmatched', label: 'Поставщик не найден' },
  { key: 'skipped', label: 'Повторы (дубликаты)' },
  { key: 'errors', label: 'Ошибок' },
  { key: 'feedback_up', label: 'Отзывов 👍' },
  { key: 'feedback_down', label: 'Отзывов 👎' }
]

/** Coerce a stored counter to a non-negative integer (defensive against bad/absent values). */
function num(v: unknown): number {
  const n = Math.trunc(Number(v))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Build the ordered, labelled rows + derived figures from a raw counter map. Pure. */
export function summarizeMetrics(counters: Record<string, number> | null | undefined): MetricsSummary {
  const c = counters ?? {}
  const rows = METRIC_LABELS.map(({ key, label }) => ({ key, label, value: num(c[key]) }))
  const docs = num(c.docs)
  const created = num(c.created)
  const successRate = docs > 0 ? Math.min(1, created / docs) : null
  const empty = rows.every(r => r.value === 0)
  return { rows, successRate, empty }
}

/** Format a 0..1 rate as an integer percent string, or «—» when null. */
export function formatRate(rate: number | null): string {
  return rate == null ? '—' : `${Math.round(rate * 100)}%`
}
