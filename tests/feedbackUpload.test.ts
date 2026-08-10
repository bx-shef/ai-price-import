import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { attachUploadedDoc, base64Bytes, safeUploadName, MAX_UPLOAD_NAME } from '../server/utils/feedbackUpload'

/**
 * Документ, присланный БРАУЗЕРОМ, для отзыва об упавшем импорте (#506 п.3).
 *
 * Импорт, упавший на извлечении, до CRM не доходит: дела нет, вложения нет, и документ взять
 * неоткуда — а он нужен именно тогда, когда без него воспроизвести нечего. Этот путь включается
 * ТОЛЬКО в таком случае; обычный отзыв по-прежнему читает документ из дела (#461).
 */

const ROOT = new URL('..', import.meta.url).pathname
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')

function deps(over: Partial<Parameters<typeof attachUploadedDoc>[1]> = {}) {
  return {
    uploadAllowed: vi.fn(async () => true),
    checkBudget: vi.fn(async () => ({ allowed: true })),
    commit: vi.fn(async () => 'https://github.com/private/repo/blob/main/f.txt'),
    maxBytes: 1000,
    missingNotice: 'Отзыв отправлен, но документ приложить не удалось.',
    logMiss: vi.fn(),
    ...over
  }
}

describe('#506 п.3: пределы и приватность переиспользуются, а не изобретаются', () => {
  it('приёмник НЕ подтверждён приватным — байты не уходят', async () => {
    // Несущее утверждение (#200): вердикт трёхзначный, «не удалось проверить» запрещает так же, как
    // «публичный». Иначе опечатка в имени приёмника опубликовала бы реальный счёт клиента.
    const d = deps({ uploadAllowed: vi.fn(async () => false) })
    const r = await attachUploadedDoc({ name: 'a.txt', contentBase64: b64('данные клиента') }, d)
    expect(d.commit).not.toHaveBeenCalled()
    expect(r.fileUrl).toBeUndefined()
    expect(r.notice).toBeTruthy()
  })

  it('приватность спрашивается ДО загрузки байт', async () => {
    const order: string[] = []
    const d = deps({
      uploadAllowed: vi.fn(async () => {
        order.push('privacy')
        return true
      }),
      commit: vi.fn(async () => {
        order.push('commit')
        return 'u'
      })
    })
    await attachUploadedDoc({ name: 'a.txt', contentBase64: b64('x'.repeat(20)) }, d)
    expect(order).toEqual(['privacy', 'commit'])
  })

  it('исчерпанный общий предел приёмника — отзыв уходит, файл нет, и это СКАЗАНО', async () => {
    const d = deps({ checkBudget: vi.fn(async () => ({ allowed: false, notice: 'предел исчерпан' })) })
    const r = await attachUploadedDoc({ name: 'a.txt', contentBase64: b64('данные') }, d)
    expect(d.commit).not.toHaveBeenCalled()
    expect(r.notice).toBe('предел исчерпан')
  })

  it('слишком большой файл отвергается ДО пробы и ДО траты чужой квоты', async () => {
    const d = deps({ maxBytes: 8 })
    const r = await attachUploadedDoc({ name: 'a.txt', contentBase64: b64('это заметно длиннее восьми байт') }, d)
    expect(d.uploadAllowed).not.toHaveBeenCalled()
    expect(d.checkBudget).not.toHaveBeenCalled()
    expect(r.notice).toBeTruthy()
  })

  it('размер считается БЕЗ декодирования', () => {
    // Декодировать сперва значило бы развернуть в память ровно то, что мы собираемся отвергнуть.
    expect(base64Bytes(b64('abc'))).toBe(3)
    expect(base64Bytes(b64('a'.repeat(100)))).toBe(100)
    expect(base64Bytes('')).toBe(0)
  })

  it('мусор вместо base64 не тратит ни пробу, ни предел', async () => {
    const d = deps()
    const r = await attachUploadedDoc({ name: 'a.txt', contentBase64: 'не base64!!!' }, d)
    expect(d.uploadAllowed).not.toHaveBeenCalled()
    expect(r.notice).toBeTruthy()
  })

  it('промах НИКОГДА не молчит — иначе «Спасибо за отзыв» читается как «документ ушёл»', async () => {
    const cases = [
      deps({ uploadAllowed: vi.fn(async () => false) }),
      deps({ commit: vi.fn(async () => null) }),
      deps({
        commit: vi.fn(async () => {
          throw new Error('boom')
        })
      })
    ]
    for (const d of cases) {
      const r = await attachUploadedDoc({ name: 'a.txt', contentBase64: b64('данные') }, d)
      expect(r.fileUrl).toBeUndefined()
      expect(r.notice, 'промах обязан быть назван').toBeTruthy()
    }
  })

  it('отказ приёмника не роняет отправку отзыва', async () => {
    // Отзыв ценнее вложения и обязан уйти в любом случае.
    const d = deps({
      commit: vi.fn(async () => {
        throw new Error('github down')
      })
    })
    await expect(attachUploadedDoc({ name: 'a.txt', contentBase64: b64('данные') }, d)).resolves.toBeTruthy()
  })
})

describe('#506 п.3: имя файла не уводит за пределы каталога', () => {
  it('путь из имени не собирается', () => {
    // Имя приходит от клиента и становится ЧАСТЬЮ ПУТИ в приёмнике: без чистки `../` увёл бы файл
    // из каталога портала, а слэш создал бы вложенные папки.
    expect(safeUploadName('../../secrets.env')).not.toContain('..')
    expect(safeUploadName('../../secrets.env')).not.toContain('/')
    expect(safeUploadName('a/b/c.txt')).not.toContain('/')
    expect(safeUploadName('..\\..\\win.txt')).not.toContain('\\')
  })

  it('пустое и мусорное имя не даёт пустого пути', () => {
    expect(safeUploadName('')).toBe('document.bin')
    expect(safeUploadName(null)).toBe('document.bin')
    expect(safeUploadName('...')).toBeTruthy()
    expect(safeUploadName('...').length).toBeGreaterThan(0)
  })

  it('русское имя сохраняется — оно нужно для разбора', () => {
    expect(safeUploadName('Накладная №5.pdf')).toContain('Накладная')
  })

  it('длинное имя обрезается', () => {
    expect(safeUploadName('и'.repeat(500) + '.pdf').length).toBeLessThanOrEqual(MAX_UPLOAD_NAME)
  })
})

describe('#506 п.3: проводка', () => {
  it('байты принимаются ТОЛЬКО когда дела нет', () => {
    // Путь через дело — основной: там источник проверяет сервер, здесь тело запроса контролирует
    // клиент. Условие `!fileUrl` и есть эта граница.
    const src = readFileSync(resolve(ROOT, 'server/api/feedback.post.ts'), 'utf8')
    expect(src).toMatch(/attachFile && !fileUrl && raw\?\.fileUpload/)
  })

  it('выбор файла предлагается только упавшей загрузке', () => {
    const src = readFileSync(resolve(ROOT, 'app/components/ImportJobItem.vue'), 'utf8')
    expect(src).toMatch(/:pick-file="job\.status === 'error'"/)
  })

  it('кнопка «с файлом» не работает, пока файл не выбран', () => {
    // Иначе «Отправить с файлом» отправит БЕЗ файла, и человек будет уверен, что документ ушёл.
    const src = readFileSync(resolve(ROOT, 'app/components/FeedbackWidget.vue'), 'utf8')
    expect(src).toMatch(/:disabled="sending \|\| \(pickFile && !chosen\)"/)
  })
})
