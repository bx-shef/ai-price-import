import { describe, expect, it, vi } from 'vitest'
import { deleteDocument, getDocument, saveDocument } from '../server/utils/docStore'
import type { ExtractedDocument } from '../app/types/document'

const doc: ExtractedDocument = { currency: 'BYN', items: [{ name: 'a', price: 1, quantity: 1 }] }

function fakeQuery(rows: Array<Record<string, unknown>> = []) {
  const calls: Array<{ sql: string, params?: unknown[] }> = []
  const q = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params })
    return { rows }
  })
  return { q, calls }
}

describe('docStore', () => {
  it('saveDocument upserts JSON payload', async () => {
    const { q, calls } = fakeQuery()
    await saveDocument('m', 'j', { doc, signals: {} }, q)
    expect(calls[0]!.sql).toContain('ON CONFLICT (member_id, job_id) DO UPDATE')
    expect(JSON.parse(calls[0]!.params![2] as string).doc.currency).toBe('BYN')
  })
  it('getDocument parses string payload / object payload', async () => {
    const asString = await getDocument('m', 'j', fakeQuery([{ payload: JSON.stringify({ doc, signals: { manualOverride: { entityTypeId: 31 } } }) }]).q)
    expect(asString?.signals).toEqual({ manualOverride: { entityTypeId: 31 } })
    const asObj = await getDocument('m', 'j', fakeQuery([{ payload: { doc, signals: {} } }]).q)
    expect(asObj?.doc.currency).toBe('BYN')
  })
  it('getDocument null when absent; delete issues DELETE', async () => {
    expect(await getDocument('m', 'x', fakeQuery([]).q)).toBeNull()
    const { q, calls } = fakeQuery()
    await deleteDocument('m', 'j', q)
    expect(calls[0]!.sql).toContain('DELETE FROM import_doc')
  })
  it('getDocument null on malformed payload with no doc (not {doc: undefined})', async () => {
    expect(await getDocument('m', 'j', fakeQuery([{ payload: JSON.stringify({ signals: {} }) }]).q)).toBeNull()
    expect(await getDocument('m', 'j', fakeQuery([{ payload: { signals: {} } }]).q)).toBeNull()
  })
})
