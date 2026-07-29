import { describe, expect, it } from 'vitest'
import { describeImportFailure, targetTypeName } from '../app/utils/importFailure'

describe('targetTypeName', () => {
  it('называет системные типы по-человечески, смарт-процесс — обобщённо', () => {
    expect(targetTypeName(1)).toBe('Лид')
    expect(targetTypeName(2)).toBe('Сделку')
    expect(targetTypeName(31)).toBe('Смарт-счёт')
    expect(targetTypeName(1044)).toBe('Смарт-процесс')
  })

  it('цель не выбирали вручную → нейтральная формулировка, а не «сущность #undefined»', () => {
    expect(targetTypeName(null)).toBe('выбранную запись')
    expect(targetTypeName(undefined)).toBe('выбранную запись')
    expect(targetTypeName(999)).toBe('выбранную запись') // не системный и не смарт-процесс
  })
})

describe('describeImportFailure', () => {
  it('тип недоступен на портале → называем цель и что делать дальше (жалоба #269)', () => {
    const m = describeImportFailure('Сущность CRM не поддерживается', { entityTypeId: 31 })
    expect(m).toContain('«Смарт-счёт»')
    expect(m).toContain('недоступен на вашем портале')
    expect(m).toContain('Выберите другую цель')
    expect(m).toContain('Ответ Битрикс24: Сущность CRM не поддерживается') // сырой текст — как деталь
    expect(m.startsWith('сбой обработки')).toBe(false)
  })

  it('удалённый смарт-процесс попадает в ту же ветку', () => {
    expect(describeImportFailure('Смарт-процесс не найден', { entityTypeId: 1044 })).toContain('недоступен')
  })

  it('голый NOT_FOUND НЕ считается «типа нет на портале» — это самый частый общий код Битрикс24', () => {
    // Не найден товар, компания, стадия, файл… Совет «выберите другую цель» тут только уводит в сторону.
    const m = describeImportFailure('NOT_FOUND', { entityTypeId: 2 })
    expect(m).not.toContain('Выберите другую цель')
    expect(m).toContain('Попробуйте загрузить файл снова')
  })

  it('многострочный ответ портала схлопывается в одну строку и обрезается', () => {
    const m = describeImportFailure(`строка1\n\nстрока2   ${'x'.repeat(500)}`, { entityTypeId: 2 })
    expect(m).not.toContain('\n')
    expect(m).toContain('строка1 строка2')
    expect(m.length).toBeLessThan(500)
  })

  it('нет прав → отдельный совет: открыть доступ, а не менять цель', () => {
    const m = describeImportFailure('ACCESS_DENIED', { entityTypeId: 2 })
    expect(m).toContain('не хватает прав')
    expect(m).toContain('администратора')
    expect(m).not.toContain('Выберите другую цель')
  })

  it('незнакомый ответ портала → всё равно говорим, куда шёл документ, и что можно повторить', () => {
    const m = describeImportFailure('Internal server error', { entityTypeId: 2 })
    expect(m).toContain('«Сделку»')
    expect(m).toContain('загрузить файл снова')
    expect(m).toContain('Ответ Битрикс24: Internal server error')
  })

  it('пустой текст ошибки не оставляет висящего «Ответ Битрикс24:»', () => {
    const m = describeImportFailure('   ', null)
    expect(m).not.toContain('Ответ Битрикс24')
    expect(m).toContain('выбранную запись')
  })
})
