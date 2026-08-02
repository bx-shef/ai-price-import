import { describe, expect, it } from 'vitest'
import { readTarget, targetMemoryKey, writeTarget, type TargetStore } from '../app/utils/targetMemory'

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
