import { describe, expect, it, vi } from 'vitest'
import { bumpCounter, METRICS, readCounters, resetCounters } from '../server/utils/metricsStore'

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
 * Изоляция порталов (#270). Приложение мультитенантное, метрики видит пользователь — поэтому
 * проверяем не текст запроса, а ПОВЕДЕНИЕ на игрушечной таблице: она честно исполняет три
 * наших запроса, но применяет отбор по порталу ТОЛЬКО если он реально есть в SQL. Пропадёт
 * `WHERE member_id` — тест покраснеет, а сверка строк такое пропускала бы.
 */
function memoryTable() {
  const rows: Array<{ member_id: string, name: string, value: number }> = []
  const scoped = (sql: string) => /member_id\s*=\s*\$1/.test(sql)
  const q = async (sql: string, params: unknown[] = []) => {
    const member = String(params[0] ?? '')
    if (/^\s*INSERT INTO metrics_counter/i.test(sql)) {
      const name = String(params[1])
      const by = Number(params[2])
      // PRIMARY KEY (member_id, name) — конфликт только при совпадении ОБОИХ полей.
      const hit = rows.find(r => r.member_id === member && r.name === name)
      if (hit) hit.value += by
      else rows.push({ member_id: member, name, value: by })
      return { rows: [] }
    }
    if (/^\s*SELECT/i.test(sql)) {
      return { rows: rows.filter(r => !scoped(sql) || r.member_id === member).map(r => ({ name: r.name, value: r.value })) }
    }
    if (/^\s*DELETE/i.test(sql)) {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (!scoped(sql) || rows[i]!.member_id === member) rows.splice(i, 1)
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
