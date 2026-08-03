import { describe, expect, it } from 'vitest'
import { MAX_COUNTERPARTY_NAME, supplierNotLinkedWarning, taxIdLabel, taxIdLabelBy } from '../app/utils/taxIdLabel'

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

describe('#384: новая формулировка предупреждения о контрагенте', () => {
  it('называет контрагента и номер — читателю не нужно открывать документ', () => {
    const w = supplierNotLinkedWarning('191234567', 'UNP', 'ООО "Ромашка"')
    expect(w).toContain('Контрагент ООО "Ромашка" (191234567) не найден')
    expect(w).toMatch(/номером налогоплательщика в реквизитах/)
  })

  it('имя не распозналось — текст без дыры посередине', () => {
    // Иначе собиралось бы «Контрагент  (191234567) не найден» с пустым местом. В этом случае
    // называем номер той меткой, под которой он напечатан.
    const w = supplierNotLinkedWarning('191234567', 'UNP', undefined)
    expect(w).not.toMatch(/Контрагент\s{2,}\(/)
    expect(w).toContain('по УНП 191234567')
    for (const empty of ['', '   ', '\n\t']) {
      expect(supplierNotLinkedWarning('191234567', 'UNP', empty)).toContain('по УНП 191234567')
    }
  })

  it('имя капнуто — оно приходит из документа и бывает с формой и адресом', () => {
    // Длина — новое свойство этого текста: одно такое предупреждение растянуло бы и сообщение в
    // чате, и карточку дела.
    const long = 'Общество с ограниченной ответственностью «Очень Длинное Название Организации», г. Минск, ул. Такая-то, д. 1'
    const w = supplierNotLinkedWarning('191234567', 'UNP', long)
    expect(w).not.toContain('ул. Такая-то')
    // Само имя в тексте — не длиннее капа: остальное предложение фиксировано.
    const shown = w.slice('Контрагент '.length, w.indexOf(' (191234567)'))
    expect(shown.length).toBeLessThanOrEqual(MAX_COUNTERPARTY_NAME)
  })

  it('переносы строк из документа не ломают строку', () => {
    expect(supplierNotLinkedWarning('1', 'UNP', 'ООО\n\tРомашка')).toContain('ООО Ромашка')
  })

  it('ветка «номер не распознан» не тронута — только слово «контрагент»', () => {
    const w = supplierNotLinkedWarning(undefined, undefined)
    expect(w).toMatch(/не распознан налоговый номер контрагента/)
    expect(w).toMatch(/номер напечатан в документе/)
  })

  it('последствие названо — иначе «не найден» читается как «ничего не произошло»', () => {
    expect(supplierNotLinkedWarning('1', 'UNP', 'ООО Ромашка')).toMatch(/без привязки к компании/)
  })
})
