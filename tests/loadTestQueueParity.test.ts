import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Drift guard for the queue load test (scripts/load-test-queue.mjs). The script must exercise the
// SAME BullMQ lock settings production uses — otherwise it silently keeps "proving" a tuning that no
// longer exists. The script can't just import worker.ts (that pulls the whole live infra chain), so
// the numbers are mirrored — and this test is what keeps the mirror honest.
//
// Compared by SOURCE, not by import, for the same reason. If this test fails, update the CRM_LOCK
// constant in the script to match server/queue/worker.ts (or vice versa) — do not delete the test.

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')

const num = (src: string, re: RegExp): number => {
  const m = src.match(re)
  if (!m?.[1]) throw new Error(`не найдено: ${re}`)
  return Number(m[1].replace(/_/g, ''))
}

describe('нагрузочный тест очереди сверен с боевым тюнингом лока', () => {
  const worker = read('../server/queue/worker.ts')
  const script = read('../scripts/load-test-queue.mjs')

  const prod = {
    lockDuration: num(worker, /CRM_LOCK_DURATION_MS\s*=\s*([\d_]+)/),
    stalledInterval: num(worker, /CRM_STALLED_INTERVAL_MS\s*=\s*([\d_]+)/),
    maxStalledCount: num(worker, /CRM_MAX_STALLED_COUNT\s*=\s*([\d_]+)/)
  }
  const test = {
    lockDuration: num(script, /CRM_LOCK\s*=\s*\{\s*lockDuration:\s*([\d_]+)/),
    stalledInterval: num(script, /CRM_LOCK\s*=\s*\{[^}]*stalledInterval:\s*([\d_]+)/),
    maxStalledCount: num(script, /CRM_LOCK\s*=\s*\{[^}]*maxStalledCount:\s*([\d_]+)/)
  }

  it('lockDuration / stalledInterval / maxStalledCount совпадают с server/queue/worker.ts', () => {
    expect(test).toEqual(prod)
  })

  it('гард безопасности на месте: скрипт отказывается работать с удалённым Redis без явного флага', () => {
    expect(script).toContain('--allow-remote-redis')
    expect(script).toMatch(/LOCAL_HOSTS/)
    // obliterate() допускается только для собственных временных очередей прогона
    expect(script).toContain('q.name.startsWith(\'loadtest-\')')
  })
})
