import { describe, expect, it } from 'vitest'
import { allLinesSkippedError } from '../app/utils/importOutcome'

describe('#373: текст исхода «ни одна позиция не перенесена»', () => {
  it('называет исход прямо, а не через «часть строк»', () => {
    const t = allLinesSkippedError(5)
    expect(t).toMatch(/ни одна позиция не перенесена/i)
    expect(t).not.toMatch(/часть строк/i)
  })

  it('говорит, что записи в CRM нет — иначе её пойдут искать в воронке', () => {
    expect(allLinesSkippedError(3)).toMatch(/не создана/i)
  })

  it('называет обе починки: завести товары ИЛИ сменить настройку', () => {
    // Повторная загрузка того же файла ничего не изменит, поэтому текст обязан вести к настройке.
    const t = allLinesSkippedError(1)
    expect(t).toMatch(/каталог/i)
    expect(t).toMatch(/произвольную позицию/i)
  })

  it('склоняет число позиций по-русски', () => {
    expect(allLinesSkippedError(1)).toContain('1 позиция')
    expect(allLinesSkippedError(2)).toContain('2 позиции')
    expect(allLinesSkippedError(5)).toContain('5 позиций')
    expect(allLinesSkippedError(11)).toContain('11 позиций')
    expect(allLinesSkippedError(21)).toContain('21 позиция')
  })

  it('мусорное число не печатается как есть', () => {
    // Число приходит из длины массива, но текст уходит человеку в чат — дробь или минус в нём
    // читались бы как поломка приложения.
    expect(allLinesSkippedError(-4)).toContain('0 позиций')
    expect(allLinesSkippedError(2.7)).toContain('2 позиции')
  })
})
