import { describe, expect, it } from 'vitest'
import { ALLOWED_EXT, fileExtension, MAX_UPLOAD_BYTES, planUploadBatch, UPLOAD_ACCEPT, validateUploadFile } from '../app/utils/importUpload'

describe('validateUploadFile', () => {
  it('accepts allowed formats', () => {
    expect(validateUploadFile({ name: 'накладная.PDF', size: 1000 }).ok).toBe(true)
    expect(validateUploadFile({ name: 'a.xlsx', size: 1000 }).ok).toBe(true)
  })
  it('rejects unknown ext / empty / oversize', () => {
    expect(validateUploadFile({ name: 'a.exe', size: 10 }).error).toMatch(/формат/)
    expect(validateUploadFile({ name: 'a.pdf', size: 0 }).error).toMatch(/Пустой/)
    expect(validateUploadFile({ name: 'a.pdf', size: MAX_UPLOAD_BYTES + 1 }).error).toMatch(/больше/)
  })
})

describe('UPLOAD_ACCEPT (mobile-friendly file picker)', () => {
  it('lists MIME types (so mobile pickers don\'t grey out valid files) + image/* for the camera', () => {
    expect(UPLOAD_ACCEPT).toContain('application/pdf')
    expect(UPLOAD_ACCEPT).toContain('image/*') // camera / photo library on mobile
    expect(UPLOAD_ACCEPT).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') // .xlsx
  })
  it('still lists every ALLOWED_EXT extension as a fallback', () => {
    for (const ext of ALLOWED_EXT) expect(UPLOAD_ACCEPT).toContain(`.${ext}`)
  })
})

describe('fileExtension', () => {
  it('handles dotless and multi-dot names', () => {
    expect(fileExtension('noext')).toBe('')
    expect(fileExtension('a.b.PDF')).toBe('pdf')
  })
})

describe('planUploadBatch', () => {
  it('separates accepted/rejected and truncates over the cap', () => {
    const files = [
      { name: 'a.pdf', size: 100 },
      { name: 'b.exe', size: 100 },
      ...Array.from({ length: 12 }, (_, i) => ({ name: `f${i}.pdf`, size: 100 }))
    ]
    const plan = planUploadBatch(files, 10)
    expect(plan.accepted.length + plan.rejected.length).toBe(10)
    expect(plan.rejected[0]!.file.name).toBe('b.exe')
    expect(plan.truncated).toBe(files.length - 10)
  })
})
