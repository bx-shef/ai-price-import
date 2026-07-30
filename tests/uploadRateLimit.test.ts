import { beforeEach, describe, expect, it } from 'vitest'
import {
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
  it('40 загрузок за 10 минут — как написано в документации', () => {
    expect(UPLOAD_LIMIT).toBe(40)
    expect(UPLOAD_WINDOW_MS).toBe(600_000)
  })
})

describe('uploadRateKey', () => {
  it('разные сотрудники одного портала — разные ключи', () => {
    expect(uploadRateKey('m1', '7')).not.toBe(uploadRateKey('m1', '8'))
  })

  it('один сотрудник в разных порталах не делит счётчик', () => {
    expect(uploadRateKey('m1', '7')).not.toBe(uploadRateKey('m2', '7'))
  })

  // Без разделителя `m1` + `17` и `m11` + `7` дали бы один ключ, и лимит одного сотрудника
  // расходовался бы чужими загрузками.
  it('склейка не порождает совпадений', () => {
    expect(uploadRateKey('m1', '17')).not.toBe(uploadRateKey('m11', '7'))
  })
})

describe('checkUploadRate', () => {
  beforeEach(() => resetUploadRateLimit())

  it('обычная пачка документов проходит целиком', () => {
    for (let i = 0; i < UPLOAD_LIMIT; i++) {
      expect(checkUploadRate('m', '7', NOW + i).allowed).toBe(true)
    }
  })

  it('следующая сверх лимита — отказ', () => {
    for (let i = 0; i < UPLOAD_LIMIT; i++) checkUploadRate('m', '7', NOW)
    expect(checkUploadRate('m', '7', NOW).allowed).toBe(false)
  })

  // Точное значение, а не «больше нуля»: ждать надо ровно до выхода из окна САМОЙ СТАРОЙ попытки.
  // Если брать самую свежую, отказанному скажут ждать почти целое окно вместо секунд.
  it('срок ожидания считается от самой старой попытки в окне', () => {
    for (let i = 0; i < UPLOAD_LIMIT; i++) checkUploadRate('m', '7', NOW + i)
    const d = checkUploadRate('m', '7', NOW + 10_000)
    expect(d.allowed).toBe(false)
    expect(d.retryAfterMs).toBe(UPLOAD_WINDOW_MS - 10_000)
  })

  // Ради чего лимит на СОТРУДНИКА, а не на адрес: портал — это офис за одним внешним адресом.
  it('исчерпавший лимит не мешает коллеге', () => {
    for (let i = 0; i < UPLOAD_LIMIT + 5; i++) checkUploadRate('m', '7', NOW)
    expect(checkUploadRate('m', '8', NOW).allowed).toBe(true)
  })

  it('и не мешает другому порталу', () => {
    for (let i = 0; i < UPLOAD_LIMIT + 5; i++) checkUploadRate('m1', '7', NOW)
    expect(checkUploadRate('m2', '7', NOW).allowed).toBe(true)
  })

  // Портал, не отдавший id сотрудника, получает ОДИН счётчик на всех. Это осознанный fail-closed
  // (лучше ограничить портал, чем выдать безлимит), но это ровно то, на что там будут жаловаться,
  // поэтому поведение закреплено, а не просто равенство строк.
  it('без id сотрудника весь портал делит один счёт', () => {
    for (let i = 0; i < UPLOAD_LIMIT; i++) checkUploadRate('m', null, NOW)
    expect(checkUploadRate('m', undefined, NOW).allowed).toBe(false)
    expect(checkUploadRate('m2', null, NOW).allowed).toBe(true)
  })

  it('окно съезжает — через окно можно снова', () => {
    for (let i = 0; i < UPLOAD_LIMIT; i++) checkUploadRate('m', '7', NOW)
    expect(checkUploadRate('m', '7', NOW).allowed).toBe(false)
    expect(checkUploadRate('m', '7', NOW + UPLOAD_WINDOW_MS + 1).allowed).toBe(true)
  })

  // Граница исключающая: ровно через окно самая старая попытка уже НЕ считается. Закреплено,
  // потому что «10 минут» в документации иначе можно прочитать двояко, а разница видна человеку —
  // он смотрит на часы и жмёт кнопку.
  it('ровно через окно попытка уже освободила место', () => {
    for (let i = 0; i < UPLOAD_LIMIT; i++) checkUploadRate('m', '7', NOW)
    expect(checkUploadRate('m', '7', NOW + UPLOAD_WINDOW_MS - 1).allowed).toBe(false)
    expect(checkUploadRate('m', '7', NOW + UPLOAD_WINDOW_MS).allowed).toBe(true)
  })

  // Отказ не должен продлевать наказание: иначе тот, кто упрямо жмёт кнопку, откладывает себе
  // разблокировку бесконечно — лимит превращается из ограничения темпа в вечную блокировку.
  it('отказ не расходует квоту и не отодвигает разблокировку', () => {
    for (let i = 0; i < UPLOAD_LIMIT; i++) checkUploadRate('m', '7', NOW)
    // Упрямых попыток столько же, сколько влезает в лимит: если бы отказы считались, они бы сами
    // заполнили окно заново, и человек, который просто жмёт кнопку, заблокировал бы себя навсегда.
    for (let i = 0; i < UPLOAD_LIMIT; i++) checkUploadRate('m', '7', NOW + UPLOAD_WINDOW_MS / 2)
    // Разблокировка — по исходным сорока, а не по тычкам.
    expect(checkUploadRate('m', '7', NOW + UPLOAD_WINDOW_MS + 1).allowed).toBe(true)
  })

  it('сброс действительно очищает счёт, а не делает вид', () => {
    for (let i = 0; i < UPLOAD_LIMIT; i++) checkUploadRate('m', '7', NOW)
    expect(checkUploadRate('m', '7', NOW).allowed).toBe(false)
    resetUploadRateLimit()
    expect(checkUploadRate('m', '7', NOW).allowed).toBe(true)
  })
})

describe('uploadRateMessage', () => {
  it('говорит, через сколько пробовать, а не просто «нельзя»', () => {
    expect(uploadRateMessage(5 * 60_000)).toBe('Слишком много загрузок подряд. Попробуйте снова через 5 мин.')
  })

  it('меньше минуты округляется вверх', () => {
    expect(uploadRateMessage(61_000)).toBe('Слишком много загрузок подряд. Попробуйте снова через 2 мин.')
  })

  it('ноль не превращается в бессмысленное «через 0 мин»', () => {
    expect(uploadRateMessage(0)).toContain('через 1 мин')
  })
})
