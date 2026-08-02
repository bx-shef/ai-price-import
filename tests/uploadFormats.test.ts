import { describe, expect, it } from 'vitest'
import { EXT_MIME, FORMATS_HUMAN, SUPPORTED_EXT, buildAccept } from '../app/config/uploadFormats'
import { ALLOWED_EXT, validateUploadFile } from '../app/utils/importUpload'
import { DEMO_AI_EXT, DEMO_ALLOWED_EXT, DEMO_TEXT_EXT, DEMO_XLSX_EXT, validateDemoFile } from '../server/utils/demoUpload'
import { planExtraction } from '../server/utils/textExtract'

// #341: the landing demo and the in-portal import kept independent format lists. The demo accepted
// CSV/TXT/.doc and the portal did not, so a prospect's CSV price-list «worked» on the landing and was
// refused right after install — promise before the install, refusal after. These tests are what keeps
// the two gates (and the extraction pipeline behind them) from drifting apart again.
describe('форматы демо и приложения — один список', () => {
  // Мутационная проверка показала: все остальные тесты берут SUPPORTED_EXT как ВХОД, поэтому
  // потеря формата им невидима — циклы просто делают меньше работы. Расширение списка ловилось,
  // сужение — нет, а это ровно тот отказ, который #341 и чинит. Пин делает список осознанным.
  it('список форматов меняется только осознанно (пин против тихой потери формата)', () => {
    expect([...SUPPORTED_EXT]).toEqual([
      'pdf', 'png', 'jpg', 'jpeg',
      'xlsx', 'xls', 'docx', 'doc',
      'csv', 'tsv', 'txt'
    ])
  })

  // Прежняя версия сверяла ALLOWED_EXT с SUPPORTED_EXT — а это буквально один и тот же объект
  // (реэкспорт), то есть сравнение массива с его же копией: тавтология. Проверяем ЖИВОЙ гейт —
  // он переживёт рефактор, в котором ALLOWED_EXT перестанет быть реэкспортом.
  it('гейт приложения пропускает каждый заявленный формат (в любом регистре) и режет чужой', () => {
    for (const ext of SUPPORTED_EXT) {
      expect(validateUploadFile({ name: `прайс.${ext}`, size: 1000 }).ok, `.${ext}`).toBe(true)
      expect(validateUploadFile({ name: `ПРАЙС.${ext.toUpperCase()}`, size: 1000 }).ok, `.${ext} прописью`).toBe(true)
    }
    expect(validateUploadFile({ name: 'архив.zip', size: 1000 }).ok).toBe(false)
    expect([...ALLOWED_EXT]).toEqual([...SUPPORTED_EXT]) // на случай возврата к отдельному массиву
  })

  it('демо принимает то же самое (плюс легаси-алиас .text)', () => {
    expect([...DEMO_ALLOWED_EXT].sort()).toEqual([...SUPPORTED_EXT, 'text'].sort())
  })

  it('каждый заявленный формат действительно умеет разбираться конвейером', () => {
    // Гейт может обещать что угодно; настоящий предел — маршрутизация извлечения. Формат, который
    // сюда не попал, приняли бы и уронили уже в воркере — отказ после загрузки, худший момент.
    for (const ext of SUPPORTED_EXT) {
      expect(planExtraction(`файл.${ext}`).kind, `.${ext} не маршрутизируется в textExtract`).not.toBe('unsupported')
    }
  })

  it('маршрутизация демо покрывает весь список — иначе файл молча декодируется как текст', () => {
    // В `extract.post.ts` порядок такой: AI → xlsx → «иначе просто раскодировать как текст».
    // Расширение, не попавшее ни в одну корзину, свалилось бы в последнюю ветку и дало мусор.
    const routed = new Set([...DEMO_TEXT_EXT, ...DEMO_XLSX_EXT, ...DEMO_AI_EXT])
    for (const ext of SUPPORTED_EXT) {
      expect(routed.has(ext), `.${ext} принят демо, но не отнесён ни к одной ветке разбора`).toBe(true)
    }
  })

  it('accept выдаёт каждое расширение и не забывает MIME (мобильный выбирает по MIME)', () => {
    const tokens = buildAccept().split(',')
    for (const ext of SUPPORTED_EXT) expect(tokens).toContain(`.${ext}`)
    // Требование выводится из SUPPORTED_EXT, а НЕ из самого EXT_MIME: прежний цикл шёл по
    // проверяемому объекту, поэтому удаление записи просто укорачивало цикл и проходило молча —
    // а это ровно тот отказ, ради которого MIME здесь и лежат («на телефоне файл не выбрать»).
    const COVERED_BY_IMAGE = new Set(['png', 'jpg', 'jpeg'])
    for (const ext of SUPPORTED_EXT) {
      if (COVERED_BY_IMAGE.has(ext)) continue
      expect(EXT_MIME[ext], `.${ext} без MIME — мобильный пикер его не покажет`).toBeTruthy()
      expect(tokens).toContain(EXT_MIME[ext] as string)
    }
    expect(tokens).toContain('image/*') // камера на телефоне
  })

  it('текстовый путь остался бесплатным: CSV/TXT не уходят в AI-ветку демо', () => {
    // Ради этого демо и держало текстовые форматы: разбор мгновенный и не тратит суточный бюджет (#321).
    for (const ext of ['csv', 'tsv', 'txt']) expect(DEMO_AI_EXT).not.toContain(ext)
  })

  it('человеческий список форматов не врёт про то, что принимается', () => {
    expect(FORMATS_HUMAN).toMatch(/CSV/) // добавили — значит, называем
    expect(FORMATS_HUMAN).toMatch(/PDF/)
    expect(FORMATS_HUMAN).toMatch(/Excel/)
  })

  it('живой отказ демо по неподдерживаемому формату называет общий список', () => {
    const v = validateDemoFile('архив.zip', 1000)
    expect(v.ok).toBe(false)
    expect(v.status).toBe(415)
    expect(v.error).toContain(FORMATS_HUMAN)
  })
})
