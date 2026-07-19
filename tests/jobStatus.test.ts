import { describe, expect, it } from 'vitest'
import { jobStatusMeta, parseJobResult, pluralRu } from '../app/utils/jobStatus'

describe('jobStatusMeta', () => {
  it('maps each status to label/tone/terminal', () => {
    expect(jobStatusMeta('queued')).toMatchObject({ tone: 'neutral', terminal: false })
    expect(jobStatusMeta('extracting').terminal).toBe(false)
    expect(jobStatusMeta('processing').terminal).toBe(false)
    expect(jobStatusMeta('done')).toMatchObject({ tone: 'success', terminal: true })
    expect(jobStatusMeta('error')).toMatchObject({ tone: 'danger', terminal: true })
  })
  it('falls back gracefully for unknown status', () => {
    expect(jobStatusMeta('weird')).toEqual({ label: 'weird', tone: 'neutral', terminal: false })
    expect(jobStatusMeta('').label).toBe('неизвестно')
  })
})

describe('parseJobResult', () => {
  it('parses crm-sync JSON result', () => {
    const r = parseJobResult(JSON.stringify({ entityId: 555, created: true, warnings: ['w'], errors: [] }))
    expect(r).toEqual({ entityId: 555, created: true, warnings: ['w'], errors: [] })
  })
  it('surfaces entityTypeId when present (#192 п.2), drops it when 0/absent', () => {
    expect(parseJobResult(JSON.stringify({ entityTypeId: 2, entityId: 5, created: true, warnings: [], errors: [] })))
      .toEqual({ entityTypeId: 2, entityId: 5, created: true, warnings: [], errors: [] })
    // absent entityTypeId → not in the view (back-compat with pre-#192 rows)
    expect(parseJobResult(JSON.stringify({ entityId: 5, created: true, warnings: [], errors: [] })).entityTypeId).toBeUndefined()
    expect(parseJobResult(JSON.stringify({ entityTypeId: 0, entityId: 5, created: true, warnings: [], errors: [] })).entityTypeId).toBeUndefined()
  })
  it('treats a bare error string as a message', () => {
    expect(parseJobResult('извлечение текста: pdftotext missing')).toEqual({ warnings: [], errors: [], message: 'извлечение текста: pdftotext missing' })
  })
  it('empty result → empty view', () => {
    expect(parseJobResult('')).toEqual({ warnings: [], errors: [] })
  })
  it('malformed JSON → message fallback; drops entityId 0', () => {
    expect(parseJobResult('{bad json').message).toBe('{bad json')
    expect(parseJobResult(JSON.stringify({ entityId: 0, errors: ['e'] }))).toEqual({ warnings: [], errors: ['e'] })
  })
  it('parses supplier + lines for the «разбор»', () => {
    const r = parseJobResult(JSON.stringify({ entityId: 5, created: true, supplier: '  ООО Ромашка  ', lines: 3, warnings: [], errors: [] }))
    expect(r).toEqual({ entityId: 5, created: true, supplier: 'ООО Ромашка', lines: 3, warnings: [], errors: [] })
  })
  it('drops blank supplier / negative lines, keeps lines:0', () => {
    expect(parseJobResult(JSON.stringify({ entityId: 5, supplier: '   ', lines: -1, warnings: [], errors: [] })))
      .toEqual({ entityId: 5, warnings: [], errors: [] })
    expect(parseJobResult(JSON.stringify({ entityId: 5, lines: 0, warnings: [], errors: [] })).lines).toBe(0)
  })
})

describe('pluralRu', () => {
  const f: [string, string, string] = ['позиция', 'позиции', 'позиций']
  it('picks the right Russian plural form', () => {
    expect(pluralRu(1, f)).toBe('позиция')
    expect(pluralRu(2, f)).toBe('позиции')
    expect(pluralRu(4, f)).toBe('позиции')
    expect(pluralRu(5, f)).toBe('позиций')
    expect(pluralRu(11, f)).toBe('позиций') // 11-14 → many
    expect(pluralRu(21, f)).toBe('позиция')
    expect(pluralRu(0, f)).toBe('позиций')
    expect(pluralRu(112, f)).toBe('позиций') // 112 → «…надцать» (teens) → many
    expect(pluralRu(122, f)).toBe('позиции') // ends in 22 → few
  })
})
