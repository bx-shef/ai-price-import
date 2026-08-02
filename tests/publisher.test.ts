import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PUBLISHER, PUBLISHER_PERSON } from '../app/config/publisher'
import { LANDING_PUBLISHER } from '../app/utils/landing'

// #297 п.1: реквизиты жили тремя независимыми копиями и УЖЕ разошлись — короткое имя писалось
// и «ИП Шевчик И.С.», и «ИП Шевчик И. С.». На лендинге это косметика, а в лицензионном соглашении
// правообладателя зовут ровно одним способом, поэтому копия обязана быть одна.
//
// Тест бьёт по ЛИТЕРАЛАМ в исходниках: обычная проверка «компонент показывает УНП» прошла бы и
// с локальной копией — она ловит вывод, а не источник.
const APP_DIR = new URL('../app/', import.meta.url).pathname
const SOURCE_FILE = 'config/publisher.ts'

/** Все .ts/.vue приложения, кроме самого источника. */
function appSources(dir = APP_DIR, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) appSources(full + '/', acc)
    else if (/\.(ts|vue)$/.test(name) && !full.endsWith(SOURCE_FILE)) acc.push(full)
  }
  return acc
}

describe('реквизиты издателя — один источник (#297)', () => {
  it('ни один файл приложения не держит собственную копию', () => {
    // Телефон в двух формах: человеческая копия и `tel:`-копия разъезжаются независимо.
    const literals = [PUBLISHER.unp, PUBLISHER.email, PUBLISHER.phone, PUBLISHER.phoneTel, PUBLISHER.telegram]
    const offenders: string[] = []
    for (const file of appSources()) {
      const text = readFileSync(file, 'utf8')
      for (const literal of literals) {
        if (text.includes(literal)) offenders.push(`${file.replace(APP_DIR, 'app/')} → «${literal}»`)
      }
    }
    expect(offenders, `реквизиты берём из app/${SOURCE_FILE}, а не переписываем:\n${offenders.join('\n')}`).toEqual([])
  })

  it('короткое имя издателя пишется ровно одним способом', () => {
    // Прежнее расхождение: «И.С.» без пробела в landing.ts против «И. С.» в футере и на визитке.
    expect(LANDING_PUBLISHER).toBe(PUBLISHER.shortName)
    const spellings = new Set<string>()
    for (const file of appSources()) {
      for (const m of readFileSync(file, 'utf8').matchAll(/ИП Шевчик[^'"«»\n]*/g)) spellings.add(m[0].trim())
    }
    expect([...spellings], 'в исходниках осталось написание имени издателя мимо PUBLISHER.shortName').toEqual([])
  })

  it('подпись УНП строится из самого номера — иначе они разойдутся', () => {
    expect(PUBLISHER.unpLabel).toContain(PUBLISHER.unp)
  })

  it('телефон для набора — тот же номер без разделителей', () => {
    expect(PUBLISHER.phoneTel).toBe(`+${PUBLISHER.phone.replace(/\D/g, '')}`)
  })

  it('полное имя человека собирается из частей — визитка и vCard не разъедутся', () => {
    expect(PUBLISHER_PERSON.fullName).toBe(`${PUBLISHER_PERSON.firstName} ${PUBLISHER_PERSON.lastName}`)
  })
})
