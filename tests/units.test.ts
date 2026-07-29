import { describe, expect, it } from 'vitest'
import type { UnitsConfig } from '../app/types/mapping'
import { BUILTIN_UNIT_CODES, foldUnitForLookup, resolveMeasure } from '../app/utils/units'
import { RAW_UNIT_SYNONYMS } from '../app/config/unitSynonyms'

// Codes from a live portal (catalog.measure.list): 796=шт (default), 166=кг.
const CFG: UnitsConfig = {
  dictionary: { шт: 796, штука: 796, дана: 796, кг: 166 },
  defaultCode: 796,
  autoCreate: true
}

describe('resolveMeasure', () => {
  it('maps a known unit (case-insensitive, multilingual)', () => {
    expect(resolveMeasure('шт', CFG)).toMatchObject({ code: 796, matched: true, source: 'portal' })
    expect(resolveMeasure('КГ', CFG)).toMatchObject({ code: 166, matched: true, source: 'portal' })
    expect(resolveMeasure('дана', CFG)).toMatchObject({ code: 796, matched: true }) // kk «дана»
  })

  it('folds ШТ/Шт/шт. (case + trailing dot) to the same «шт» dictionary entry', () => {
    for (const u of ['ШТ', 'Шт', 'шт.', ' шт. ']) expect(resolveMeasure(u, CFG)).toMatchObject({ code: 796, matched: true })
  })

  it('unknown → default code, matched=false (auto-create + warning)', () => {
    expect(resolveMeasure('зюзюблик', CFG)).toEqual({ code: 796, matched: false })
    expect(resolveMeasure(undefined, CFG)).toEqual({ code: 796, matched: false })
  })
})

// #272: до этого словарь портала по умолчанию пуст, и в CRM ВСЁ, кроме штук, уезжало штуками.
describe('resolveMeasure: встроенный словарь единиц (#272)', () => {
  const EMPTY: UnitsConfig = { dictionary: {}, defaultCode: 796, autoCreate: false }

  it('на свежем портале с пустым словарём единицы распознаются сразу, а не подменяются штуками', () => {
    expect(resolveMeasure('кг', EMPTY)).toMatchObject({ code: 166, matched: true, source: 'builtin' })
    expect(resolveMeasure('т', EMPTY)).toMatchObject({ code: 168, matched: true })
    expect(resolveMeasure('л', EMPTY)).toMatchObject({ code: 112, matched: true })
    expect(resolveMeasure('рулон', EMPTY)).toMatchObject({ code: 736, matched: true })
    expect(resolveMeasure('упак', EMPTY)).toMatchObject({ code: 778, matched: true })
  })

  it('словоформы, регистр и хвостовая точка: штук/штуки/ШТ. → 796', () => {
    for (const u of ['штук', 'штуки', 'штука', 'ШТ.', 'Штук']) {
      expect(resolveMeasure(u, EMPTY), u).toMatchObject({ code: 796, matched: true })
    }
  })

  it('внутренние точки и надстрочные знаки: пог.м / п.м → метр, м2 и м² → одно и то же', () => {
    for (const u of ['пог.м', 'п.м', 'м.п.', 'погонный метр']) {
      expect(resolveMeasure(u, EMPTY), u).toMatchObject({ code: 6, matched: true })
    }
    expect(resolveMeasure('м2', EMPTY)).toMatchObject({ code: 55 })
    expect(resolveMeasure('м²', EMPTY)).toMatchObject({ code: 55 })
    expect(resolveMeasure('кв. м', EMPTY)).toMatchObject({ code: 55 })
    expect(resolveMeasure('м3', EMPTY)).toMatchObject({ code: 113 })
    expect(resolveMeasure('м³', EMPTY)).toMatchObject({ code: 113 })
  })

  it('латинские написания распознаются потому, что перечислены явно (свёртки букв нет)', () => {
    expect(resolveMeasure('kg', EMPTY)).toMatchObject({ code: 166, matched: true })
    expect(resolveMeasure('m', EMPTY)).toMatchObject({ code: 6, matched: true })
    expect(resolveMeasure('t', EMPTY)).toMatchObject({ code: 168, matched: true })
    // Не перечислено — значит не распознаётся. Это осознанно: автоматическая свёртка латиницы в
    // кириллицу расширяла бы совпадения молча, в поле, которое никто не перепроверяет.
    expect(resolveMeasure('kgs', EMPTY)).toEqual({ code: 796, matched: false })
  })

  it('«комплект» и «набор» — разные коды ОКЕИ (839 и 704), не свалены в один', () => {
    expect(resolveMeasure('комплект', EMPTY)).toMatchObject({ code: 839 })
    expect(resolveMeasure('к-т', EMPTY)).toMatchObject({ code: 839 })
    expect(resolveMeasure('набор', EMPTY)).toMatchObject({ code: 704 })
  })

  it('внутри встроенной карты нет коллизий: два разных кода не дают один ключ поиска', () => {
    // Идти надо по ИСХОДНЫМ данным: собранная карта дедуплицирует ключи молча
    // (`if (!map.has(key))`), поэтому по ней коллизию не увидеть в принципе.
    const seen = new Map<string, { code: number, spelling: string }>()
    for (const [code, spellings] of Object.entries(RAW_UNIT_SYNONYMS)) {
      expect(spellings.length, `у кода ${code} нет ни одного написания`).toBeGreaterThan(0)
      for (const spelling of spellings) {
        const key = foldUnitForLookup(spelling)
        expect(key, `написание «${spelling}» сворачивается в пустой ключ`).not.toBe('')
        const prev = seen.get(key)
        expect(
          prev === undefined || prev.code === Number(code),
          `«${spelling}» и «${prev?.spelling}» дают один ключ «${key}», но разные коды: ${prev?.code} и ${code}`
        ).toBe(true)
        seen.set(key, { code: Number(code), spelling })
      }
    }
    expect(BUILTIN_UNIT_CODES.size).toBe(seen.size)
    // И обратная сторона: свёртка не должна схлопывать разные единицы.
    expect(foldUnitForLookup('м²')).toBe(foldUnitForLookup('м2'))
    expect(foldUnitForLookup('м²')).not.toBe(foldUnitForLookup('м³'))
    expect(foldUnitForLookup('кв.м')).not.toBe(foldUnitForLookup('куб.м'))
  })

  it('казахское «дана» распознаётся без настройки портала', () => {
    expect(resolveMeasure('дана', EMPTY)).toMatchObject({ code: 796, matched: true, source: 'builtin' })
  })

  it('запись администратора ПЕРЕКРЫВАЕТ встроенную — портал мог завести свою меру', () => {
    const custom: UnitsConfig = { dictionary: { кг: 1042 }, defaultCode: 796, autoCreate: false }
    expect(resolveMeasure('кг', custom)).toMatchObject({ code: 1042, source: 'portal' })
    expect(resolveMeasure('КГ.', custom)).toMatchObject({ code: 1042, source: 'portal' })
  })

  it('запись администратора выигрывает и при ином написании — иначе обещание держалось бы побуквенно', () => {
    const custom: UnitsConfig = { dictionary: { 'кв.м': 1050 }, defaultCode: 796, autoCreate: false }
    for (const u of ['кв. м', 'кв м', 'м2', 'м²']) {
      // «м2»/«м²» сворачиваются к тому же ключу, что и «кв.м»? Нет — проверяем только варианты
      // написания САМОЙ записи администратора; коды из встроенной карты сюда не должны прорываться.
      const r = resolveMeasure(u, custom)
      if (foldUnitForLookup(u) === foldUnitForLookup('кв.м')) expect(r).toMatchObject({ code: 1050, source: 'portal' })
    }
    expect(resolveMeasure('кв. м', custom)).toMatchObject({ code: 1050, source: 'portal' })
  })

  it('действительно незнакомая единица по-прежнему даёт matched=false', () => {
    expect(resolveMeasure('бухта', EMPTY)).toEqual({ code: 796, matched: false })
  })
})
