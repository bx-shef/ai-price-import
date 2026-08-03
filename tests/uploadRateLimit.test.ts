import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  FEEDBACK_LIMIT,
  checkFeedbackRate,
  feedbackRateMessage,
  resetFeedbackRateLimit,
  UPLOAD_LIMIT,
  UPLOAD_WINDOW_MS,
  checkUploadRate,
  resetUploadRateLimit,
  uploadRateKey,
  uploadRateMessage
} from '../server/utils/uploadRateLimit'

const NOW = 1_000_000_000

// Числа закреплены литералами НАМЕРЕННО. Доки (PROCESS.md §6.8, PROJECT_MAP.md) обещают
// пользователю «40 за 10 минут»; если сверять тест с самой константой, правка одной цифры молча
// разойдётся с обещанием.
describe('порог', () => {
  it('40 загрузок за 10 минут — как написано в документации', async () => {
    expect(UPLOAD_LIMIT).toBe(40)
    expect(UPLOAD_WINDOW_MS).toBe(600_000)
  })
})

describe('uploadRateKey', () => {
  it('разные сотрудники одного портала — разные ключи', async () => {
    expect(uploadRateKey('m1', '7')).not.toBe(uploadRateKey('m1', '8'))
  })

  it('один сотрудник в разных порталах не делит счётчик', async () => {
    expect(uploadRateKey('m1', '7')).not.toBe(uploadRateKey('m2', '7'))
  })

  // Без разделителя `m1` + `17` и `m11` + `7` дали бы один ключ, и лимит одного сотрудника
  // расходовался бы чужими загрузками.
  it('склейка не порождает совпадений', async () => {
    expect(uploadRateKey('m1', '17')).not.toBe(uploadRateKey('m11', '7'))
  })
})

describe('checkUploadRate', () => {
  beforeEach(() => resetUploadRateLimit())

  it('обычная пачка документов проходит целиком', async () => {
    for (let i = 0; i < UPLOAD_LIMIT; i++) {
      expect((await checkUploadRate('m', '7', NOW + i)).allowed).toBe(true)
    }
  })

  it('следующая сверх лимита — отказ', async () => {
    for (let i = 0; i < UPLOAD_LIMIT; i++) await checkUploadRate('m', '7', NOW)
    expect((await checkUploadRate('m', '7', NOW)).allowed).toBe(false)
  })

  // ⚠ Окно ФИКСИРОВАННОЕ, а не скользящее (#353: счёт переехал в Redis). Скользящему нужны метки
  // времени каждой попытки — это упорядоченное множество на ключ и совсем другой объём, ради
  // точности, которая здесь не нужна: задача — оборвать неуправляемый цикл, а не отмерить до
  // штуки. Поэтому ждать надо до КОНЦА текущего окна, и это точное число: «больше нуля» пропустило
  // бы и «ждите почти полное окно» на второй секунде.
  it('срок ожидания — до конца текущего окна', async () => {
    const base = Math.floor(NOW / UPLOAD_WINDOW_MS) * UPLOAD_WINDOW_MS
    for (let i = 0; i <= UPLOAD_LIMIT; i++) await checkUploadRate('m', '7', base + 10_000)
    const d = await checkUploadRate('m', '7', base + 10_000)
    expect(d.allowed).toBe(false)
    expect(d.retryAfterMs).toBe(UPLOAD_WINDOW_MS - 10_000)
  })

  // Плата за фиксированное окно, названная вслух: на стыке двух окон подряд проходит до двух
  // лимитов. Для предела, который существует, чтобы оборвать зациклившегося клиента, это приемлемо
  // — но записано тестом, чтобы никто не считал это ошибкой и не «чинил» молча.
  it('на стыке окон подряд проходит до двух лимитов — осознанная плата', async () => {
    const edge = Math.floor((NOW + UPLOAD_WINDOW_MS) / UPLOAD_WINDOW_MS) * UPLOAD_WINDOW_MS
    for (let i = 0; i < UPLOAD_LIMIT; i++) expect((await checkUploadRate('m', '7', edge - 1)).allowed).toBe(true)
    for (let i = 0; i < UPLOAD_LIMIT; i++) expect((await checkUploadRate('m', '7', edge)).allowed).toBe(true)
  })

  // Ради чего лимит на СОТРУДНИКА, а не на адрес: портал — это офис за одним внешним адресом.
  it('исчерпавший лимит не мешает коллеге', async () => {
    for (let i = 0; i < UPLOAD_LIMIT + 5; i++) await checkUploadRate('m', '7', NOW)
    expect((await checkUploadRate('m', '8', NOW)).allowed).toBe(true)
  })

  it('и не мешает другому порталу', async () => {
    for (let i = 0; i < UPLOAD_LIMIT + 5; i++) await checkUploadRate('m1', '7', NOW)
    expect((await checkUploadRate('m2', '7', NOW)).allowed).toBe(true)
  })

  // Портал, не отдавший id сотрудника, получает ОДИН счётчик на всех. Это осознанный fail-closed
  // (лучше ограничить портал, чем выдать безлимит), но это ровно то, на что там будут жаловаться,
  // поэтому поведение закреплено, а не просто равенство строк.
  it('без id сотрудника весь портал делит один счёт', async () => {
    for (let i = 0; i < UPLOAD_LIMIT; i++) await checkUploadRate('m', null, NOW)
    expect((await checkUploadRate('m', undefined, NOW)).allowed).toBe(false)
    expect((await checkUploadRate('m2', null, NOW)).allowed).toBe(true)
  })

  it('окно съезжает — через окно можно снова', async () => {
    for (let i = 0; i < UPLOAD_LIMIT; i++) await checkUploadRate('m', '7', NOW)
    expect((await checkUploadRate('m', '7', NOW)).allowed).toBe(false)
    expect((await checkUploadRate('m', '7', NOW + UPLOAD_WINDOW_MS + 1)).allowed).toBe(true)
  })

  // Граница исключающая: ровно через окно самая старая попытка уже НЕ считается. Закреплено,
  // потому что «10 минут» в документации иначе можно прочитать двояко, а разница видна человеку —
  // он смотрит на часы и жмёт кнопку.
  it('в следующем окне место свободно', async () => {
    // Граница — конец окна по стенным часам, а не «через окно после первой попытки»: окно
    // фиксированное (#353). Человек смотрит на часы, поэтому разница ему видна.
    const base = Math.floor(NOW / UPLOAD_WINDOW_MS) * UPLOAD_WINDOW_MS
    for (let i = 0; i < UPLOAD_LIMIT; i++) await checkUploadRate('m', '7', base + 1)
    expect((await checkUploadRate('m', '7', base + UPLOAD_WINDOW_MS - 1)).allowed).toBe(false)
    expect((await checkUploadRate('m', '7', base + UPLOAD_WINDOW_MS)).allowed).toBe(true)
  })

  it('упрямые тычки не откладывают разблокировку', async () => {
    // Отказ ТИКАЕТ счётчик — фиксированное окно считает попытки, а не успехи. Важно другое: срок
    // разблокировки привязан к концу окна по стенным часам, а не к последней попытке. Иначе тот,
    // кто просто жмёт кнопку, заблокировал бы себя навсегда, и предел темпа стал бы вечной
    // блокировкой.
    const base = Math.floor(NOW / UPLOAD_WINDOW_MS) * UPLOAD_WINDOW_MS
    for (let i = 0; i < UPLOAD_LIMIT * 3; i++) await checkUploadRate('m', '7', base + 1)
    expect((await checkUploadRate('m', '7', base + UPLOAD_WINDOW_MS)).allowed).toBe(true)
  })

  it('сброс действительно очищает счёт, а не делает вид', async () => {
    for (let i = 0; i < UPLOAD_LIMIT; i++) await checkUploadRate('m', '7', NOW)
    expect((await checkUploadRate('m', '7', NOW)).allowed).toBe(false)
    resetUploadRateLimit()
    expect((await checkUploadRate('m', '7', NOW)).allowed).toBe(true)
  })
})

describe('uploadRateMessage', () => {
  it('говорит, через сколько пробовать, а не просто «нельзя»', async () => {
    expect(uploadRateMessage(5 * 60_000)).toBe('Слишком много загрузок подряд. Попробуйте снова через 5 мин.')
  })

  it('меньше минуты округляется вверх', async () => {
    expect(uploadRateMessage(61_000)).toBe('Слишком много загрузок подряд. Попробуйте снова через 2 мин.')
  })

  it('ноль не превращается в бессмысленное «через 0 мин»', async () => {
    expect(uploadRateMessage(0)).toContain('через 1 мин')
  })
})

describe('лимит отзывов (#349 ревью)', () => {
  beforeEach(() => resetFeedbackRateLimit())

  it('строже загрузок: отзыв — редкое осознанное действие', async () => {
    expect(FEEDBACK_LIMIT).toBeLessThan(UPLOAD_LIMIT)
  })

  it('пускает до лимита, дальше отказывает и говорит, когда вернуться', async () => {
    const t = 1_000_000
    for (let i = 0; i < FEEDBACK_LIMIT; i++) {
      expect((await checkFeedbackRate('m1', '7', t)).allowed, `попытка ${i + 1}`).toBe(true)
    }
    const refused = await checkFeedbackRate('m1', '7', t)
    expect(refused.allowed).toBe(false)
    expect(refused.retryAfterMs).toBeGreaterThan(0)
    expect(feedbackRateMessage(refused.retryAfterMs)).toMatch(/через \d+ мин/)
  })

  it('счётчик отзывов НЕ общий с загрузками — иначе пачка импорта съедала бы право на отзыв', async () => {
    const t = 2_000_000
    for (let i = 0; i < FEEDBACK_LIMIT; i++) await checkFeedbackRate('m2', '7', t)
    expect((await checkFeedbackRate('m2', '7', t)).allowed).toBe(false)
    expect((await checkUploadRate('m2', '7', t)).allowed).toBe(true) // загрузки нетронуты
  })

  it('лимит персональный: коллега не расплачивается за соседа', async () => {
    const t = 3_000_000
    for (let i = 0; i < FEEDBACK_LIMIT; i++) await checkFeedbackRate('m3', '7', t)
    expect((await checkFeedbackRate('m3', '7', t)).allowed).toBe(false)
    expect((await checkFeedbackRate('m3', '8', t)).allowed).toBe(true)
  })
})

describe('#353 ревью: сам ВЫЗОВ лимитера в роуте загрузки', () => {
  // Мутация «подменить решение лимитера на allowed:true» в `server/api/import/upload.post.ts`
  // оставляла ВЕСЬ набор зелёным: лимитер покрыт плотно, но покрыт в изоляции — того, что роут его
  // действительно зовёт, не проверял никто. У отзывов эту дыру уже закрывали (#351), у загрузок
  // страховки не было. Гард по исходнику, потому что проверяется именно факт вызова и его место.
  const src = readFileSync(new URL('../server/api/import/upload.post.ts', import.meta.url), 'utf8')
  const body = src.split('\n').filter(l => !/^\s*import\b/.test(l)).join('\n')

  it('роут зовёт лимитер, а не только импортирует его', () => {
    expect(body).toMatch(/await checkUploadRate\(/)
  })

  it('лимит стоит ДО чтения тела — иначе отказ уже оплачен разбором файла', () => {
    const rate = body.indexOf('checkUploadRate(')
    const read = body.indexOf('readMultipartFormData(')
    expect(rate).toBeGreaterThan(-1)
    expect(read).toBeGreaterThan(-1)
    expect(rate, 'лимит после чтения тела').toBeLessThan(read)
  })

  it('решение лимитера действительно используется, а не выбрасывается', () => {
    // Проверяем связку «получили решение → на отказе вернули 429 с retry-after».
    expect(body).toMatch(/rate\.allowed/)
    expect(body).toMatch(/rate\.retryAfterMs/)
  })
})
