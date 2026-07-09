import { describe, expect, it } from 'vitest'
import { jobStatusMeta, parseJobResult } from '../app/utils/jobStatus'

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
})
