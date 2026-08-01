import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { deleteUpload, safeSeg, saveUpload, uploadPath } from '../server/utils/fileStore'

describe('safeSeg', () => {
  it('strips separators and traversal', () => {
    expect(safeSeg('../../etc/passwd')).not.toContain('/')
    expect(safeSeg('../../etc/passwd')).not.toContain('..')
    expect(safeSeg('member.42')).toBe('member.42')
    expect(safeSeg('')).toBe('_')
    expect(safeSeg('a/b\\c')).toBe('a_b_c')
  })
})

describe('uploadPath', () => {
  it('is deterministic and confined to the base dir', () => {
    expect(uploadPath('m1', 'j1', '/base')).toBe('/base/m1/j1.bin')
    // traversal in ids cannot escape the base dir
    expect(uploadPath('../x', '../../y', '/base').startsWith('/base/')).toBe(true)
    expect(uploadPath('../x', '../../y', '/base')).not.toContain('..')
  })
})

describe('saveUpload / deleteUpload', () => {
  it('mkdir portal dir then write bytes', async () => {
    const io = { mkdir: vi.fn(async () => {}), writeFile: vi.fn(async () => {}), unlink: vi.fn(async () => {}) }
    const p = await saveUpload('m', 'j', new Uint8Array([1, 2]), io, '/base')
    expect(io.mkdir).toHaveBeenCalledWith('/base/m')
    expect(io.writeFile).toHaveBeenCalledWith('/base/m/j.bin', expect.any(Uint8Array))
    expect(p).toBe('/base/m/j.bin')
  })
  it('deleteUpload swallows a missing file', async () => {
    const io = { mkdir: vi.fn(), writeFile: vi.fn(), unlink: vi.fn(async () => {
      throw new Error('ENOENT')
    }) }
    await expect(deleteUpload('m', 'j', io, '/base')).resolves.toBeUndefined()
  })
})

describe('удержание исходника под отзыв (#200)', () => {
  // Раньше воркер удалял байты сразу после извлечения текста. Именно тот случай, ради которого
  // отзыв и существует — «документ не распознан», — не создаёт ни сущности в CRM, ни архивной копии
  // на Диске, так что прикладывать к 👎 было нечего. Проверяем сам факт: путь удаления из воркера
  // убран, а окно хранения привязано к сроку жизни задания, а не задано отдельным числом.
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')

  it('воркер НЕ удаляет загруженные байты после извлечения', () => {
    const worker = read('../server/queue/worker.ts')
    expect(worker).not.toContain('cleanupUpload')
    expect(worker).not.toMatch(/unlink\(\s*uploadPath/)
  })

  it('подметание идёт по сроку жизни задания — одна ручка, не две', () => {
    // Два независимых числа разъехались бы: файл пережил бы задание (лишнее хранение) или исчез
    // раньше (отзыв без файла ровно тогда, когда он нужен).
    const retention = read('../server/plugins/retention.ts')
    expect(retention).toContain('sweepOldUploads(JOB_TTL_MS)')
  })

  it('удаление портала по-прежнему сносит файлы сразу', () => {
    // Удержание — про срок, а не про «оставить навсегда»: деинсталляция чистит немедленно.
    expect(read('../server/utils/nodeFileIO.ts')).toContain('purgePortalFiles')
  })
})
