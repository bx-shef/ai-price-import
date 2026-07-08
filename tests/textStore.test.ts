import { describe, expect, it, vi } from 'vitest'
import { deleteText, getText, saveText } from '../server/utils/textStore'

function fakeQuery(rows: Array<Record<string, unknown>> = []) {
  const calls: Array<{ sql: string, params?: unknown[] }> = []
  const q = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params })
    return { rows }
  })
  return { q, calls }
}

describe('textStore', () => {
  it('saveText upserts', async () => {
    const { q, calls } = fakeQuery()
    await saveText('m', 'j', 'hello', q)
    expect(calls[0]!.sql).toContain('ON CONFLICT (member_id, job_id) DO UPDATE')
    expect(calls[0]!.params).toEqual(['m', 'j', 'hello'])
  })
  it('getText returns text or null (empty/absent → null)', async () => {
    expect(await getText('m', 'j', fakeQuery([{ text: 'abc' }]).q)).toBe('abc')
    expect(await getText('m', 'j', fakeQuery([{ text: '' }]).q)).toBeNull()
    expect(await getText('m', 'j', fakeQuery([]).q)).toBeNull()
  })
  it('deleteText issues DELETE', async () => {
    const { q, calls } = fakeQuery()
    await deleteText('m', 'j', q)
    expect(calls[0]!.sql).toContain('DELETE FROM import_text')
  })
})
