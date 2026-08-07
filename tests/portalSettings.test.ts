import { describe, expect, it } from 'vitest'
import { defaultMapping, isPortalConfigured, MAX_SAVINGS_RATE, parsePortalSettings } from '../app/utils/portalSettings'

describe('parsePortalSettings', () => {
  it('empty/invalid → safe defaults', () => {
    expect(parsePortalSettings(null)).toEqual(defaultMapping())
    expect(parsePortalSettings('nope')).toEqual(defaultMapping())
    expect(parsePortalSettings({}).defaultTarget).toEqual({ entityTypeId: 2, categoryId: 0 })
  })

  it('coerces article/product/units', () => {
    const m = parsePortalSettings({
      article: { field: 'PROP', kind: 'string', delimiter: ';' },
      product: { by: 'name', onMissing: 'freeform' },
      units: { dictionary: { ШТ: '796', bad: 'x' }, defaultCode: 166, autoCreate: true }
    })
    // ⚠ `scope` дозаписывается дефолтом `'product'`: настройки, сохранённые до его появления,
    // выбирались пикером, который показывал только свойства основного каталога товаров.
    expect(m.article).toEqual({ field: 'PROP', kind: 'string', scope: 'product', delimiter: ';' })
    // ⚠ Сохранённое `by: 'name'` КОЭРСИТСЯ в `'article'`: подбора по имени больше нет вовсе
    // (решение владельца 2026-08-05), и портал со старым значением обязан просто работать по
    // единственной оставшейся стратегии, а не оказаться «ненастроенным».
    expect(m.product).toEqual({ by: 'article', onMissing: 'freeform' })
    expect(m.units.dictionary).toEqual({ шт: 796 }) // lower-cased, invalid dropped
    expect(m.units.defaultCode).toBe(166)
  })

  it('legacy onMissing:"create" (removed) coerces to freeform, not skip-warn', () => {
    // Product creation was removed; a portal that still has 'create' stored must degrade to the
    // closest non-dropping behaviour (free-form line), not silently start skipping lines.
    expect(parsePortalSettings({ product: { by: 'article', onMissing: 'create' } }).product.onMissing).toBe('freeform')
    // Anything unrecognised → the safe default (#373: дефолт теперь «произвольная позиция»).
    expect(parsePortalSettings({ product: { onMissing: 'nonsense' } }).product.onMissing).toBe('freeform')
    // «Пропустить» отдаётся только по явно сохранённому значению.
    expect(parsePortalSettings({ product: { onMissing: 'skip-warn' } }).product.onMissing).toBe('skip-warn')
  })

  it('#373: пустые настройки не перебивают новый дефолт «произвольная позиция»', () => {
    // Это и есть та мутация, ради которой тест написан: если вернуть в `parsePortalSettings` прежний
    // порядок (`… ? 'freeform' : 'skip-warn'`), правка `defaultMapping` не изменит НИЧЕГО — свежий
    // портал читается через разбор пустых настроек, и он же вернул бы «пропустить».
    expect(defaultMapping().product.onMissing).toBe('freeform')
    expect(parsePortalSettings({}).product.onMissing).toBe('freeform')
    expect(parsePortalSettings(null).product.onMissing).toBe('freeform')
    // И нетронутый портал обязан по-прежнему считаться НЕнастроенным.
    expect(isPortalConfigured(parsePortalSettings({}))).toBe(false)
  })

  it('drops routing rules with empty condition, keeps valid', () => {
    const m = parsePortalSettings({
      routingRules: [
        { match: {}, target: { entityTypeId: 31 } },
        { match: { type: 'счёт' }, target: { entityTypeId: 31 } },
        { match: { keywords: ['ТН', ''] }, target: { entityTypeId: 2, categoryId: 7 } }
      ]
    })
    expect(m.routingRules).toHaveLength(2)
    expect(m.routingRules[0]!.target.entityTypeId).toBe(31)
    expect(m.routingRules[1]!.match.keywords).toEqual(['ТН'])
  })

  it('bad target entityTypeId falls back to default', () => {
    const m = parsePortalSettings({ defaultTarget: { entityTypeId: -1 } })
    expect(m.defaultTarget).toEqual({ entityTypeId: 2, categoryId: 0 })
  })
  it('caps a bloated routingRules array (DoS bound #83)', () => {
    const rules = Array.from({ length: 5000 }, () => ({ match: { type: 'x' }, target: { entityTypeId: 2 } }))
    const m = parsePortalSettings({ routingRules: rules })
    expect(m.routingRules.length).toBe(200)
  })
  it('caps rule keywords and the unit dictionary (DoS bound #83)', () => {
    const m = parsePortalSettings({
      routingRules: [{ match: { keywords: Array.from({ length: 5000 }, (_, i) => `k${i}`) }, target: { entityTypeId: 2 } }],
      units: { dictionary: Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`u${i}`, i + 1])) }
    })
    expect(m.routingRules[0]!.match.keywords!.length).toBe(100)
    expect(Object.keys(m.units.dictionary).length).toBe(1000)
  })
})

describe('isPortalConfigured', () => {
  it('pristine defaults → not configured', () => {
    expect(isPortalConfigured(defaultMapping())).toBe(false)
    expect(isPortalConfigured(parsePortalSettings(null))).toBe(false)
    expect(isPortalConfigured(parsePortalSettings({}))).toBe(false)
  })
  it('any single meaningful setting flips it to configured', () => {
    const cfg = (patch: Record<string, unknown>) => isPortalConfigured(parsePortalSettings({ ...patch }))
    expect(cfg({ article: { field: 'PROPERTY_123' } })).toBe(true)
    expect(cfg({ notifyChatId: 'chat42' })).toBe(true)
    expect(cfg({ errorChatId: 'chat7' })).toBe(true)
    expect(cfg({ routingRules: [{ match: { type: 'накладная' }, target: { entityTypeId: 2 } }] })).toBe(true)
    expect(cfg({ units: { dictionary: { шт: 796 } } })).toBe(true)
    // #458: поля `saveFile` больше нет вовсе — сохранённое значение игнорируется и признаком
    // загоралось бы у нетронутого портала, а баннер «сначала настройте» не увидел бы никто.
    expect(cfg({ saveFile: true })).toBe(false)
    expect(cfg({ saveFile: false })).toBe(false)
    // Признак настройки здесь — `onMissing: 'skip-warn'` (не дефолт); `by` больше ни на что не влияет.
    expect(cfg({ product: { by: 'name', onMissing: 'skip-warn' } })).toBe(true)
    // #373: «внести произвольной позицией» — теперь ДЕФОЛТ, значит признаком настройки быть не может
    // (иначе гейт «сначала настройте приложение» погас бы у каждого нетронутого портала).
    expect(cfg({ product: { by: 'article', onMissing: 'freeform' } })).toBe(false)
    // А «пропустить» стало осознанным выбором админа — вот оно и есть признак настройки.
    expect(cfg({ product: { by: 'article', onMissing: 'skip-warn' } })).toBe(true)
    // ⚠ Стратегия подбора признаком настройки БОЛЬШЕ НЕ ЯВЛЯЕТСЯ: выбирать нечего, подбор идёт по
    // артикулу всегда (решение владельца 2026-08-05). Сохранённое `by: 'name'` коэрсится в
    // `'article'`, то есть настройками портала не отличается от нетронутых.
    expect(cfg({ product: { by: 'name', onMissing: 'freeform' } })).toBe(false)
    expect(cfg({ units: { defaultCode: 166 } })).toBe(true)
    expect(cfg({ units: { autoCreate: true } })).toBe(true)
    expect(cfg({ defaultTarget: { entityTypeId: 31 } })).toBe(true) // moved off the deal anchor
    expect(cfg({ defaultTarget: { entityTypeId: 2, categoryId: 3 } })).toBe(true) // non-default funnel
    expect(cfg({ defaultTarget: { entityTypeId: 2, categoryId: 0, stageId: 'NEW' } })).toBe(true)
  })
  describe('#373: факт сохранения, а не сравнение с дефолтами', () => {
    // Смена дефолта `onMissing` вскрыла, что признак настройки был РЕТРОАКТИВНЫМ: портал, где админ
    // выбрал `freeform` руками, после деплоя стал «ненастроенным» — не-админу закрылся рабочий
    // экран на портале, где ничего не менялось. Флаг `configured` снимает весь класс: сохранение —
    // это событие, а не значение.
    it('сохранённые настройки считаются настройкой, даже если все значения дефолтные', () => {
      expect(isPortalConfigured(parsePortalSettings({ configured: true }))).toBe(true)
      // Именно тот портал, который ломался: единственное осознанное действие — выбор freeform.
      expect(isPortalConfigured(parsePortalSettings({ configured: true, product: { by: 'article', onMissing: 'freeform' } }))).toBe(true)
    })

    it('без флага работают прежние эвристики — порталы, сохранявшиеся до его появления', () => {
      expect(isPortalConfigured(parsePortalSettings({ article: { field: 'PROP' } }))).toBe(true)
      expect(isPortalConfigured(parsePortalSettings({ notifyChatId: 'chat1' }))).toBe(true)
    })

    it('нетронутый портал — по-прежнему не настроен', () => {
      expect(isPortalConfigured(parsePortalSettings({}))).toBe(false)
      expect(isPortalConfigured(parsePortalSettings({ configured: false }))).toBe(false)
    })

    it('флагом считается только литеральный true', () => {
      // Мусор в блобе должен читаться как «не настроен»: лишний баннер безобиден, пропущенный нет.
      for (const junk of ['true', 1, {}, [], 'yes']) {
        expect(isPortalConfigured(parsePortalSettings({ configured: junk })), String(junk)).toBe(false)
      }
    })
  })

  it('an empty article field / whitespace stays not-configured', () => {
    expect(isPortalConfigured(parsePortalSettings({ article: { field: '   ' } }))).toBe(false)
  })
})

// #270: ставка для денежной оценки. Ключа нет ⇒ денег на экране нет (валюту не выдумываем).
describe('parsePortalSettings — savings.ratePerHour', () => {
  it('отсутствует по умолчанию', () => {
    expect(defaultMapping().savings).toBeUndefined()
    expect(parsePortalSettings({}).savings).toBeUndefined()
  })
  it('положительное число проходит и округляется до копеек', () => {
    expect(parsePortalSettings({ savings: { ratePerHour: 20 } }).savings).toEqual({ ratePerHour: 20 })
    expect(parsePortalSettings({ savings: { ratePerHour: 12.345 } }).savings).toEqual({ ratePerHour: 12.35 })
  })
  it('мусор и неположительное — ключа нет, а не ноль', () => {
    for (const ratePerHour of [0, -1, 'abc', null, Number.NaN, Infinity]) {
      expect(parsePortalSettings({ savings: { ratePerHour } }).savings).toBeUndefined()
    }
    expect(parsePortalSettings({ savings: 'x' }).savings).toBeUndefined()
  })
  it('запредельная ставка клампится', () => {
    expect(parsePortalSettings({ savings: { ratePerHour: 1e12 } }).savings)
      .toEqual({ ratePerHour: MAX_SAVINGS_RATE })
  })
  it('ставка НЕ считается «портал настроен» — это косметика, а не готовность к импорту', () => {
    expect(isPortalConfigured(parsePortalSettings({ savings: { ratePerHour: 20 } }))).toBe(false)
  })
})
