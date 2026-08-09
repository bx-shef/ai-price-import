import { describe, expect, it } from 'vitest'
import { applySettingsChangeToTarget, readTarget, targetMemoryKey, writeTarget, type TargetStore } from '../app/utils/targetMemory'

function fakeStore(initial: Record<string, string> = {}): TargetStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v) },
    removeItem: (k: string) => { data.delete(k) }
  }
}

describe('targetMemoryKey', () => {
  it('ключ привязан к порталу и нечувствителен к регистру домена', () => {
    expect(targetMemoryKey('P.bitrix24.by')).toBe(targetMemoryKey('p.bitrix24.by'))
    expect(targetMemoryKey('a.bitrix24.by')).not.toBe(targetMemoryKey('b.bitrix24.by'))
  })
  it('без домена — отдельный нейтральный слот, а не чужой', () => {
    // Выбор, сделанный до готовности фрейма, не должен потом приписаться какому-то порталу.
    expect(targetMemoryKey(undefined)).toBe(targetMemoryKey(''))
    expect(targetMemoryKey(undefined)).not.toBe(targetMemoryKey('p.bitrix24.by'))
  })
})

describe('запись и чтение цели', () => {
  const KEY = targetMemoryKey('p.bitrix24.by')

  it('круг: что записали, то и прочитали', () => {
    const store = fakeStore()
    writeTarget(store, KEY, { entityTypeId: 2, categoryId: 5, stageId: 'C5:NEW' })
    expect(readTarget(store, KEY)).toEqual({ entityTypeId: 2, categoryId: 5, stageId: 'C5:NEW' })
  })

  it('хранит ТОЛЬКО идентификаторы — подписи в хранилище не попадают', () => {
    const store = fakeStore()
    writeTarget(store, KEY, { entityTypeId: 2, categoryId: 5, stageId: 'C5:NEW', title: 'Продажи' } as never)
    expect(store.data.get(KEY)).not.toContain('Продажи')
  })

  it('пустая цель стирает память, а не пишет мусор', () => {
    const store = fakeStore({ [KEY]: '{"entityTypeId":2}' })
    writeTarget(store, KEY, null)
    expect(readTarget(store, KEY)).toBeNull()
    writeTarget(store, KEY, { entityTypeId: 0 })
    expect(readTarget(store, KEY)).toBeNull()
  })

  it('битое содержимое читается как «памяти нет» — экран падает на дефолт, а не на исключение', () => {
    for (const junk of ['не json', 'null', '[]', '{}', '{"entityTypeId":"деал"}', '{"entityTypeId":-1}']) {
      expect(readTarget(fakeStore({ [KEY]: junk }), KEY), junk).toBeNull()
    }
  })

  it('частичная цель допустима: только сущность, без направления и стадии', () => {
    const store = fakeStore()
    writeTarget(store, KEY, { entityTypeId: 31 })
    expect(readTarget(store, KEY)).toEqual({ entityTypeId: 31 })
  })

  it('сломанное хранилище не роняет импорт (приватный режим, переполнение)', () => {
    const throwing: TargetStore = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('quota') },
      removeItem: () => { throw new Error('denied') }
    }
    expect(() => writeTarget(throwing, KEY, { entityTypeId: 2 })).not.toThrow()
    expect(readTarget(throwing, KEY)).toBeNull()
  })
})

describe('applySettingsChangeToTarget (#443): админ поменял настройки — что с памятью', () => {
  const nextDefault = { entityTypeId: 2, categoryId: 7 }

  it('вне прогона новая цель по умолчанию побеждает запомненную', () => {
    // Смысл рассылки в том, чтобы у всех стало как настроил админ. Память, пережившая правку,
    // отменяла бы её молча и у каждого по-своему.
    expect(applySettingsChangeToTarget({ importing: false, nextDefault }))
      .toEqual({ adopt: true, target: nextDefault })
  })

  it('во время пачки не трогаем ничего', () => {
    // Задание уже принято сервером и работает на настройках НА МОМЕНТ ПОСТАНОВКИ. Подменив цель на
    // середине, мы отправили бы остаток пачки не туда, куда ушло её начало.
    expect(applySettingsChangeToTarget({ importing: true, nextDefault }))
      .toEqual({ adopt: false, target: null })
  })

  it('цель по умолчанию не пришла — принимаем «Авто», а не оставляем прежнюю', () => {
    // `null` здесь значит «правила маршрутизации», а не «нет данных»: настройки уже перечитаны,
    // счётчик растёт ПОСЛЕ загрузки. Оставить прежнюю цель значило бы проигнорировать правку.
    expect(applySettingsChangeToTarget({ importing: false, nextDefault: null }))
      .toEqual({ adopt: true, target: null })
  })
})
