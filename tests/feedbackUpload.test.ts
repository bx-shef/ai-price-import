import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { attachUploadedDoc, base64Bytes, safeUploadName, shouldAcceptUploadedDoc, MAX_UPLOAD_NAME } from '../server/utils/feedbackUpload'

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

  it('промах не молчит и когда предел не назвал причины', () => {
    // `budget.notice` необязателен, и без общего текста человек увидел бы «Спасибо за отзыв!» без
    // единого слова о том, что документ не ушёл.
    return attachUploadedDoc({ name: 'a.txt', contentBase64: b64('данные') },
      deps({ checkBudget: vi.fn(async () => ({ allowed: false })) })
    ).then(r => expect(r.notice).toBeTruthy())
  })

  it('падение ЛЮБОЙ зависимости — промах, а не исключение', async () => {
    const boom = () => {
      throw new Error('boom')
    }
    for (const over of [{ uploadAllowed: vi.fn(boom) }, { checkBudget: vi.fn(boom) }]) {
      const r = await attachUploadedDoc({ name: 'a.txt', contentBase64: b64('данные') }, deps(over as never))
      expect(r.fileUrl).toBeUndefined()
      expect(r.notice).toBeTruthy()
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

  it('обрезка не рубит символ пополам', () => {
    // Урок #346: `slice` режет по единицам UTF-16, и срез посреди суррогатной пары даёт битую
    // строку, которая молча ломает кодирование пути в приёмнике.
    // Буква ВНЕ базовой плоскости (математическая «A») — она проходит фильтр `\\p{L}` и доживает
    // до обрезки, в отличие от эмодзи, которое схлопывается ещё фильтром.
    // ⚠ Одна буква из базовой плоскости впереди — она сдвигает границу так, что срез по единицам
    // UTF-16 приходится ПОСЕРЕДИНЕ пары. Без неё мутация «вернуть `slice`» проходила мимо теста:
    // ровные пары резались ровно, и разницы не было видно.
    const out = safeUploadName('a' + '\u{1D400}'.repeat(200))
    expect([...out].length).toBeLessThanOrEqual(MAX_UPLOAD_NAME)
    expect(/[\uD800-\uDFFF]/.test(out.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')),
      'в имени остался обломок суррогатной пары').toBe(false)
  })
})

describe('#506 п.3: байты из тела принимаются только при вердикте «дела нет»', () => {
  // ⚠ Проверяется ПОВЕДЕНИЕ решения, а не текст условия в роуте. Первая редакция гарда грепала
  // исходник на `attachFile && !fileUrl && raw?.fileUpload` — и мимо неё прошла бы и приписка ещё
  // одного условия, и, главное, сам дефект: `!fileUrl` границей не был.
  const base = { attachFile: true, fileUrl: undefined, miss: 'no-activity', hasUpload: true }

  it('дела нет — принимаем', () => {
    expect(shouldAcceptUploadedDoc(base)).toBe(true)
  })

  it('дело ЕСТЬ, но прочитать не вышло — НЕ принимаем', () => {
    // Здесь документ у сервера есть, просто не дался: скачивание сорвалось, портал ответил
    // страницей входа, файл велик. Принять байты страницы значит подменить проверенный источник
    // непроверенным — ровно то, что запретил #461.
    for (const miss of ['download-failed', 'login-page', 'too-big', 'unsafe-url', 'no-file']) {
      expect(shouldAcceptUploadedDoc({ ...base, miss }), miss).toBe(false)
    }
  })

  it('путь через дело даже не запускался — НЕ принимаем', () => {
    // `jobId` не прислали ⇒ промаха нет вовсе. Раньше это был самый простой способ протащить
    // произвольный файл: не назвать задание, и фолбэк срабатывал безусловно.
    expect(shouldAcceptUploadedDoc({ ...base, miss: undefined })).toBe(false)
  })

  it('предел приёмника исчерпан — НЕ принимаем', () => {
    // Иначе второй источник обходил бы общий предел (#354) первого.
    expect(shouldAcceptUploadedDoc({ ...base, miss: 'budget' })).toBe(false)
  })

  it('документ уже приложен из дела — второй источник не нужен', () => {
    expect(shouldAcceptUploadedDoc({ ...base, fileUrl: 'https://x/y' })).toBe(false)
  })

  it('согласия не давали или файла нет — не принимаем', () => {
    expect(shouldAcceptUploadedDoc({ ...base, attachFile: false })).toBe(false)
    expect(shouldAcceptUploadedDoc({ ...base, hasUpload: false })).toBe(false)
  })

  it('роут применяет именно это решение, а не своё', () => {
    // Единственная текстовая проверка, и она сторожит НЕ логику, а то, что логика вызвана: сама
    // логика покрыта выше поведением.
    const src = readFileSync(resolve(ROOT, 'server/api/feedback.post.ts'), 'utf8')
    expect(src).toMatch(/if \(shouldAcceptUploadedDoc\(/)
  })

  it('выбор файла предлагается только загрузке, не дошедшей до CRM', () => {
    // ⚠ Одного «ошибки» мало: запись создаётся ВСЕГДА (#459), и у половины упавших строк дело есть.
    const src = readFileSync(resolve(ROOT, 'app/components/ImportJobItem.vue'), 'utf8')
    expect(src).toMatch(/:pick-file="job\.status === 'error' && !result\.entityId"/)
  })

  it('кнопка «с файлом» не работает, пока файл не выбран', () => {
    // Иначе «Отправить с файлом» отправит БЕЗ файла, и человек будет уверен, что документ ушёл.
    const src = readFileSync(resolve(ROOT, 'app/components/FeedbackWidget.vue'), 'utf8')
    expect(src).toMatch(/:disabled="sending \|\| \(pickFile && !chosen\)"/)
  })
})
