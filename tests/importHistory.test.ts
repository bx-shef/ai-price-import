import { describe, expect, it } from 'vitest'
import { addImportJob, importFeedbackKind, importJobIds, markImportFeedback, readHistory, type StorageLike } from '../app/utils/importHistory'

function memStorage(): StorageLike & { dump: () => string | null } {
  let v: string | null = null
  return {
    getItem: () => v,
    setItem: (_k, val) => { v = val },
    dump: () => v
  }
}

describe('importHistory (localStorage, keyed by jobId)', () => {
  it('addImportJob remembers file + orders newest-first', () => {
    const s = memStorage()
    addImportJob(s, 'j1', 'a.pdf', 1000)
    addImportJob(s, 'j2', 'b.pdf', 2000)
    expect(readHistory(s, 2000).map(e => e.jobId)).toEqual(['j2', 'j1'])
    expect(importJobIds(s, 2000)).toEqual(['j2', 'j1'])
  })

  it('re-adding a jobId de-dupes (updates, keeps one entry) and preserves its feedback flag', () => {
    const s = memStorage()
    addImportJob(s, 'j1', 'a.pdf', 1000)
    markImportFeedback(s, 'j1', 'down', 1500)
    addImportJob(s, 'j1', 'a.pdf', 2000) // re-upload / refresh
    const h = readHistory(s, 2000)
    expect(h).toHaveLength(1)
    expect(h[0]!.feedback).toBe('down') // not lost
  })

  it('feedback flag round-trips and suppresses re-asking', () => {
    const s = memStorage()
    addImportJob(s, 'j1', 'a.pdf', 1000)
    expect(importFeedbackKind(s, 'j1', 1000)).toBeUndefined()
    markImportFeedback(s, 'j1', 'up', 1000)
    expect(importFeedbackKind(s, 'j1', 1000)).toBe('up')
  })

  it('markImportFeedback upserts when the job is unknown (widget knows only jobId)', () => {
    const s = memStorage()
    markImportFeedback(s, 'jX', 'down', 1000)
    expect(importFeedbackKind(s, 'jX', 1000)).toBe('down')
  })

  it('TTL-prunes entries older than 7 days', () => {
    const s = memStorage()
    addImportJob(s, 'old', 'a.pdf', 0)
    const now = 8 * 24 * 60 * 60 * 1000
    addImportJob(s, 'new', 'b.pdf', now)
    expect(readHistory(s, now).map(e => e.jobId)).toEqual(['new'])
  })

  it('caps at 50 entries (newest kept)', () => {
    const s = memStorage()
    for (let i = 0; i < 60; i++) addImportJob(s, `j${i}`, 'f.pdf', 1000 + i)
    const h = readHistory(s, 2000)
    expect(h).toHaveLength(50)
    expect(h[0]!.jobId).toBe('j59')
    expect(h.some(e => e.jobId === 'j0')).toBe(false)
  })

  it('bad / non-array JSON → empty, never throws', () => {
    const s = memStorage()
    s.setItem('procure:import:history', '{not json')
    expect(readHistory(s)).toEqual([])
    s.setItem('procure:import:history', '{"a":1}')
    expect(readHistory(s)).toEqual([])
  })
})
