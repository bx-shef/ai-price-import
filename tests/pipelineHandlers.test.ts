import { describe, expect, it, vi } from 'vitest'
import { handleAgentRunJob, handleFileExtractJob, MAX_ROUTING_TEXT } from '../server/queue/handlers'
import type { ExtractedDocument } from '../app/types/document'

const doc: ExtractedDocument = { documentType: 'накладная', currency: 'BYN', items: [{ name: 'a', price: 1, quantity: 1 }] }

describe('handleFileExtractJob', () => {
  function deps(over = {}) {
    return {
      extractText: vi.fn(async () => 'DOCUMENT TEXT'),
      saveText: vi.fn(async () => {}),
      enqueueAgentRun: vi.fn(async () => {}),
      failJob: vi.fn(async () => {}),
      ...over
    }
  }
  it('text → saveText + enqueue agent-run', async () => {
    const d = deps()
    const r = await handleFileExtractJob({ memberId: 'm', jobId: 'j', fileId: 'f' }, d)
    expect(r.ok).toBe(true)
    expect(d.saveText).toHaveBeenCalledWith('m', 'j', 'DOCUMENT TEXT')
    expect(d.enqueueAgentRun).toHaveBeenCalledWith('m', 'j')
    expect(d.failJob).not.toHaveBeenCalled()
  })
  it('extractor throws → failJob, no enqueue', async () => {
    const d = deps({ extractText: vi.fn(async () => {
      throw new Error('pdftotext missing')
    }) })
    const r = await handleFileExtractJob({ memberId: 'm', jobId: 'j', fileId: 'f' }, d)
    expect(r.ok).toBe(false)
    expect(d.failJob).toHaveBeenCalledWith('m', 'j', expect.stringContaining('pdftotext missing'))
    expect(d.enqueueAgentRun).not.toHaveBeenCalled()
  })
  it('empty/whitespace text → failJob', async () => {
    const d = deps({ extractText: vi.fn(async () => '   \n ') })
    const r = await handleFileExtractJob({ memberId: 'm', jobId: 'j', fileId: 'f' }, d)
    expect(r.ok).toBe(false)
    expect(d.failJob).toHaveBeenCalledWith('m', 'j', expect.stringContaining('пустой текст'))
  })
})

describe('handleAgentRunJob', () => {
  function deps(over = {}) {
    return {
      getDocumentText: vi.fn(async () => 'DOCUMENT TEXT'),
      extractDocument: vi.fn(async () => ({ document: doc })),
      saveDocument: vi.fn(async () => {}),
      enqueueCrmSync: vi.fn(async () => {}),
      failJob: vi.fn(async () => {}),
      deleteText: vi.fn(async () => {}),
      ...over
    }
  }
  it('extract → store {doc, signals} → drop text → enqueue crm-sync', async () => {
    const d = deps()
    const r = await handleAgentRunJob({ memberId: 'm', jobId: 'j' }, d)
    expect(r.ok).toBe(true)
    const [, , stored] = d.saveDocument.mock.calls[0]!
    expect(stored.doc).toBe(doc)
    expect(stored.signals).toMatchObject({ documentType: 'накладная', text: 'DOCUMENT TEXT' })
    expect(d.deleteText).toHaveBeenCalledWith('m', 'j')
    expect(d.enqueueCrmSync).toHaveBeenCalledWith('m', 'j')
  })
  it('applies manual override into signals when provided', async () => {
    const d = deps({ getManualOverride: vi.fn(async () => ({ entityTypeId: 31 })) })
    await handleAgentRunJob({ memberId: 'm', jobId: 'j' }, d)
    const [, , stored] = d.saveDocument.mock.calls[0]!
    expect(stored.signals.manualOverride).toEqual({ entityTypeId: 31 })
  })
  it('bounds routing text to MAX_ROUTING_TEXT', async () => {
    const big = 'x'.repeat(MAX_ROUTING_TEXT + 5000)
    const d = deps({ getDocumentText: vi.fn(async () => big) })
    await handleAgentRunJob({ memberId: 'm', jobId: 'j' }, d)
    const [, , stored] = d.saveDocument.mock.calls[0]!
    expect(stored.signals.text).toHaveLength(MAX_ROUTING_TEXT)
  })
  it('no text → failJob, no extraction', async () => {
    const d = deps({ getDocumentText: vi.fn(async () => null) })
    const r = await handleAgentRunJob({ memberId: 'm', jobId: 'j' }, d)
    expect(r.ok).toBe(false)
    expect(d.extractDocument).not.toHaveBeenCalled()
    expect(d.failJob).toHaveBeenCalledWith('m', 'j', expect.stringContaining('текст документа не найден'))
  })
  it('extraction returns nothing → failJob with reason, no enqueue', async () => {
    const d = deps({ extractDocument: vi.fn(async () => ({ document: null, error: 'агент не извлёк табличную часть' })) })
    const r = await handleAgentRunJob({ memberId: 'm', jobId: 'j' }, d)
    expect(r.ok).toBe(false)
    expect(d.failJob).toHaveBeenCalledWith('m', 'j', expect.stringContaining('не извлёк'))
    expect(d.enqueueCrmSync).not.toHaveBeenCalled()
  })
  it('cleanup (deleteText) failure never blocks enqueue', async () => {
    const d = deps({ deleteText: vi.fn(async () => {
      throw new Error('db down')
    }) })
    const r = await handleAgentRunJob({ memberId: 'm', jobId: 'j' }, d)
    expect(r.ok).toBe(true)
    expect(d.enqueueCrmSync).toHaveBeenCalled()
  })
})
