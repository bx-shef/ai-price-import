import { readFileSync } from 'node:fs'
import { UPLOAD_ORPHAN_MAX_AGE_MS } from '../server/utils/nodeFileIO'
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

describe('исходник НЕ хранится на сервере (#349, откат #200)', () => {
  // #200 держал загруженные байты весь срок жизни задания, чтобы 👎 на «документ не распознан» было
  // что приложить. Владелец не готов держать документы клиента сутки, поэтому удаление вернулось
  // сразу после извлечения текста, а файл к отзыву прикладывает САМА СТРАНИЦА из своей памяти.
  // Проверяем оба конца: сервер удаляет, и никто не вернул хранение «на всякий случай».
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')

  it('воркер удаляет загруженные байты НА ОСНОВНОМ пути, сразу после извлечения', () => {
    // Мутационная проверка вскрыла дыру в первой версии этого теста: он искал `cleanupUpload` по
    // ВСЕМУ файлу, а удаление есть ещё в обработчике исчерпанных попыток и в самом определении
    // функции. Поэтому удаление с основного пути можно было убрать — тест оставался зелёным, а
    // хранение молча возвращалось. Смотрим ИМЕННО тело extract-воркера и порядок вызовов.
    const worker = read('../server/queue/worker.ts')
    const body = worker.slice(worker.indexOf('QUEUES.extract'), worker.indexOf('QUEUES.agent'))
    expect(body, 'в теле extract-воркера нет удаления байтов').toContain('cleanupUpload(data)')
    // Удаление обязано идти ПОСЛЕ разбора: иначе извлекать было бы не из чего.
    expect(body.indexOf('handleFileExtractJob')).toBeLessThan(body.indexOf('cleanupUpload(data)'))
    // Сама реализация действительно удаляет файл задания, а не «делает вид».
    expect(worker).toMatch(/unlink\(\s*uploadPath\(job\.memberId, job\.jobId\)\s*\)/)
  })

  it('свип — подстраховка от сирот, а не срок хранения: окно НЕ привязано к жизни задания', () => {
    // Привязка к JOB_TTL_MS означала бы «держим файл, пока задание можно оценить», то есть ровно то
    // хранение, от которого отказались. Сироты — это файлы заданий, не дошедших до извлечения.
    const retention = read('../server/plugins/retention.ts')
    expect(retention).toContain('UPLOAD_ORPHAN_MAX_AGE_MS')
    expect(retention).not.toContain('JOB_TTL_MS')
  })

  it('окно сирот измеряется часами, а не сутками', () => {
    expect(UPLOAD_ORPHAN_MAX_AGE_MS).toBeLessThanOrEqual(12 * 60 * 60 * 1000)
    expect(UPLOAD_ORPHAN_MAX_AGE_MS).toBeGreaterThan(0)
  })

  it('удаление портала по-прежнему сносит файлы сразу', () => {
    expect(read('../server/utils/nodeFileIO.ts')).toContain('purgePortalFiles')
  })

  it('роут отзыва не читает файл С ДИСКА — своей копии документа нет', () => {
    // Инвариант тот же, что был (#349): байты загрузки удаляются сразу после извлечения текста, и
    // читать их обратно неоткуда. ⚠ Изменился ИСТОЧНИК вложения: со страницы (`parseClientFile`) на
    // вложение дела таймлайна (#461) — это покрыто гардами в `feedbackIntake`. Здесь остаётся
    // единственное утверждение, которое принадлежит хранилищу файлов: с диска роут не читает.
    expect(read('../server/api/feedback.post.ts')).not.toContain('readUploadBase64')
  })
})
