import { describe, expect, it } from 'vitest'
import { supplierNotLinkedWarning, taxIdLabel, taxIdLabelBy } from '../app/utils/taxIdLabel'

describe('taxIdLabel', () => {
  it('называет номер так, как он подписан в документе', () => {
    expect(taxIdLabel('INN')).toBe('ИНН')
    expect(taxIdLabel('UNP')).toBe('УНП')
    expect(taxIdLabel('BIN')).toBe('БИН') // русская форма казахского «БСН»
    expect(taxIdLabel('IIN')).toBe('ИИН')
  })

  it('метка не распозналась → родовое «налоговый номер», без перечисления аббревиатур', () => {
    expect(taxIdLabel(undefined)).toBe('налоговый номер')
    expect(taxIdLabel('XXX' as never)).toBe('налоговый номер')
  })

  it('в обороте «не найден по …» аббревиатура не склоняется, а родовое название склоняется', () => {
    expect(taxIdLabelBy('UNP')).toBe('УНП')
    expect(taxIdLabelBy(undefined)).toBe('налоговому номеру')
  })
})

describe('supplierNotLinkedWarning', () => {
  it('номер есть, компании нет → печатаем сам номер и его метку', () => {
    const w = supplierNotLinkedWarning('191234567', 'UNP')
    expect(w).toContain('по УНП 191234567')
    expect(w).toContain('Заведите компанию')
    expect(w).not.toContain('УНП/ИНН')
  })

  it('метка неизвестна → номер всё равно печатаем', () => {
    expect(supplierNotLinkedWarning('7701234567', undefined)).toContain('по налоговому номеру 7701234567')
  })

  it('номера в документе нет → другое сообщение: искать было не по чему', () => {
    const w = supplierNotLinkedWarning(undefined, undefined)
    expect(w).toContain('не распознан налоговый номер')
    expect(w).not.toContain('Заведите компанию') // это действие тут не помогает
  })
})
