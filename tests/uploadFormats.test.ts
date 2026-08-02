import { describe, expect, it } from 'vitest'
import { EXT_MIME, FORMATS_HUMAN, SUPPORTED_EXT, buildAccept } from '../app/config/uploadFormats'
import { ALLOWED_EXT } from '../app/utils/importUpload'
import { DEMO_AI_EXT, DEMO_ALLOWED_EXT, DEMO_TEXT_EXT, DEMO_XLSX_EXT, validateDemoFile } from '../server/utils/demoUpload'
import { planExtraction } from '../server/utils/textExtract'

// #341: the landing demo and the in-portal import kept independent format lists. The demo accepted
// CSV/TXT/.doc and the portal did not, so a prospect's CSV price-list «worked» on the landing and was
// refused right after install — promise before the install, refusal after. These tests are what keeps
// the two gates (and the extraction pipeline behind them) from drifting apart again.
describe('форматы демо и приложения — один список', () => {
  it('приложение принимает ровно то, что заявлено общим источником', () => {
    expect([...ALLOWED_EXT]).toEqual([...SUPPORTED_EXT])
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
    for (const mime of Object.values(EXT_MIME)) expect(tokens).toContain(mime)
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
