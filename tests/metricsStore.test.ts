import { describe, expect, it, vi } from 'vitest'
import { bumpCounter, METRICS, readCounters, readTotals, resetCounters } from '../server/utils/metricsStore'

function fakeQuery(rows: Array<Record<string, unknown>> = []) {
  const calls: Array<{ sql: string, params?: unknown[] }> = []
  const q = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params })
    return { rows }
  })
  return { q, calls }
}

describe('bumpCounter', () => {
  it('upserts with additive ON CONFLICT', async () => {
    const { q, calls } = fakeQuery()
    await bumpCounter('m', METRICS.created, 3, q)
    expect(calls[0]!.sql).toContain('value = metrics_counter.value + EXCLUDED.value')
    expect(calls[0]!.params).toEqual(['m', 'created', 3])
  })
  it('truncates fractional deltas', async () => {
    const { q, calls } = fakeQuery()
    await bumpCounter('m', 'x', 2.9, q)
    expect(calls[0]!.params![2]).toBe(2)
  })
  it('no-op on zero / non-finite', async () => {
    const { q } = fakeQuery()
    await bumpCounter('m', 'x', 0, q)
    await bumpCounter('m', 'x', Number.NaN, q)
    await bumpCounter('m', 'x', Infinity, q)
    expect(q).not.toHaveBeenCalled()
  })
})

describe('readCounters', () => {
  it('maps rows to name→value', async () => {
    const out = await readCounters('m', fakeQuery([{ name: 'created', value: '5' }, { name: 'errors', value: 2 }]).q)
    expect(out).toEqual({ created: 5, errors: 2 })
  })
  it('empty when no rows', async () => {
    expect(await readCounters('m', fakeQuery([]).q)).toEqual({})
  })
})

describe('resetCounters', () => {
  it('deletes only the caller portal counters (member-scoped)', async () => {
    const { q, calls } = fakeQuery()
    await resetCounters('m42', q)
    expect(calls[0]!.sql).toContain('DELETE FROM metrics_counter WHERE member_id=$1')
    expect(calls[0]!.params).toEqual(['m42'])
  })
})

/**
 * Cross-portal isolation (#270). The app is multitenant and the counters are user-visible, so this
 * checks BEHAVIOUR on a toy table rather than the text of a query.
 *
 * The toy table interprets the statement instead of sniffing it for a substring: the INSERT's own
 * column list and ON CONFLICT target decide the row key, and only a WHERE that is EXACTLY
 * `member_id=$1` scopes a SELECT/DELETE. So all three ways of losing the scope go red —
 * dropping member_id from the INSERT key, dropping the WHERE, and weakening it to
 * `member_id=$1 OR true` (which a substring check would happily accept).
 */
function memoryTable() {
  const rows: Array<Record<string, string | number>> = []
  const cols = (sql: string, after: RegExp) => (sql.match(after)?.[1] ?? '').split(',').map(s => s.trim()).filter(Boolean)
  /** `true` only for a WHERE that scopes to the caller's portal and nothing else. */
  const scoped = (sql: string) => {
    const where = sql.split(/\bWHERE\b/i)[1]
    return where !== undefined && where.replace(/\s+/g, '') === 'member_id=$1'
  }
  const q = async (sql: string, params: unknown[] = []) => {
    const member = String(params[0] ?? '')
    if (/^\s*INSERT INTO metrics_counter/i.test(sql)) {
      // Build the row from the columns the statement actually names, then apply ON CONFLICT over
      // the conflict target it actually declares — so a lost `member_id` in either place shows up.
      const names = cols(sql, /INSERT INTO metrics_counter\s*\(([^)]*)\)/i)
      const key = cols(sql, /ON CONFLICT\s*\(([^)]*)\)/i)
      const row: Record<string, string | number> = {}
      names.forEach((c, i) => {
        row[c] = c === 'value' ? Number(params[i]) : String(params[i])
      })
      const hit = rows.find(r => key.every(k => r[k] === row[k]))
      if (hit) hit.value = Number(hit.value) + Number(row.value)
      else rows.push(row)
      return { rows: [] }
    }
    if (/^\s*SELECT/i.test(sql)) {
      const visible = scoped(sql) ? rows.filter(r => r.member_id === member) : rows
      return { rows: visible.map(r => ({ name: r.name, value: r.value })) }
    }
    if (/^\s*DELETE/i.test(sql)) {
      const doomed = scoped(sql) ? (r: Record<string, string | number>) => r.member_id === member : () => true
      for (let i = rows.length - 1; i >= 0; i--) {
        if (doomed(rows[i]!)) rows.splice(i, 1)
      }
      return { rows: [] }
    }
    throw new Error(`unexpected sql: ${sql}`)
  }
  return q
}

describe('метрики двух порталов не пересекаются', () => {
  it('запись на портале A не меняет счётчики портала B', async () => {
    const q = memoryTable()
    await bumpCounter('A', METRICS.docs, 3, q)
    await bumpCounter('B', METRICS.docs, 1, q)
    await bumpCounter('A', METRICS.docs, 2, q)
    expect(await readCounters('A', q)).toEqual({ docs: 5 })
    expect(await readCounters('B', q)).toEqual({ docs: 1 })
  })

  it('чтение отдаёт только свои счётчики', async () => {
    const q = memoryTable()
    await bumpCounter('A', METRICS.created, 7, q)
    await bumpCounter('B', METRICS.errors, 9, q)
    expect(await readCounters('A', q)).toEqual({ created: 7 })
    expect(await readCounters('B', q)).toEqual({ errors: 9 })
  })

  it('сброс на портале A не задевает соседа', async () => {
    const q = memoryTable()
    await bumpCounter('A', METRICS.lines, 4, q)
    await bumpCounter('B', METRICS.lines, 4, q)
    await resetCounters('A', q)
    expect(await readCounters('A', q)).toEqual({})
    expect(await readCounters('B', q)).toEqual({ lines: 4 })
  })

  it('отзыв 👍 с портала A не попадает в счётчики B', async () => {
    const q = memoryTable()
    await bumpCounter('A', METRICS.feedbackUp, 1, q)
    expect(await readCounters('B', q)).toEqual({})
  })
})

// #271-C: накопительный итог по всем порталам для консоли оператора.
describe('readTotals', () => {
  it('суммирует по имени счётчика', async () => {
    const { q, calls } = fakeQuery([{ name: 'docs', value: '12' }, { name: 'created', value: 11 }])
    expect(await readTotals(q)).toEqual({ docs: 12, created: 11 })
    expect(calls[0]!.sql).toContain('GROUP BY name')
  })

  it('разбивка по порталам не доходит до ответа', async () => {
    // Проверяем ВЫХОД, а не текст запроса: сверка строки ловит «кто-то добавил member_id в SELECT»,
    // но не ловит «id просочился в ключи ответа другим путём».
    const { q, calls } = fakeQuery([
      { name: 'docs', value: 5, member_id: 'портал-A' },
      { name: 'docs', value: 7, member_id: 'портал-B' }
    ])
    expect(Object.keys(await readTotals(q))).toEqual(['docs'])
    expect(calls[0]!.sql).not.toMatch(/SELECT[^]*member_id/i)
  })

  it('отдаёт только то, что консоль показывает', async () => {
    const { q } = fakeQuery([
      { name: 'docs', value: 1 },
      { name: 'feedback_up', value: 9 },
      { name: 'unmatched', value: 4 }
    ])
    // Отзывы и «поставщик не найден» на этот экран не выводятся — незачем и слать.
    expect(await readTotals(q)).toEqual({ docs: 1 })
  })

  it('пусто, когда счётчиков ещё нет', async () => {
    expect(await readTotals(fakeQuery([]).q)).toEqual({})
  })
})
