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
//
// ⚠ Два разных правила для кода и для документов, и это НЕ упущение:
//   • код (`app/`, `server/`) обязан ИМПОРТИРОВАТЬ реквизиты — литерал там запрещён;
//   • юридический документ обязан их ЦИТИРОВАТЬ — запретить литерал в тексте лицензии нельзя.
// Поэтому документы проверяются иначе: написание имени в них должно совпадать с источником
// (ровно то расхождение, ради которого задача и заведена), а сам литерал разрешён.
const ROOT = new URL('../', import.meta.url).pathname
const CODE_ROOTS = ['app', 'server']
const SOURCE_FILE = 'app/config/publisher.ts'
// ⚠ `contracts.md` добавлен 12.08.2026 (#419) по разбору проверяющих: это документ, уходящий
// клиенту и юристу, и он цитирует реквизиты гуще остальных — имя, УНП, адрес, счета. Первая
// редакция уже успела ввести четвёртое написание («ИП Шевчик Игорь Сергеевич» — гибрид короткой и
// полной формы, которого в `publisher.ts` нет), и поймал его человек, а не гард.
const LEGAL_DOCS = ['docs/privacy-policy.md', 'docs/PRICING.md', 'docs/eula.md', 'docs/contracts.md']

/** Все .ts/.vue в коде приложения и сервера, кроме самого источника. */
function codeSources(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) codeSources(full, acc)
    else if (/\.(ts|vue)$/.test(name) && !full.endsWith(SOURCE_FILE)) acc.push(full)
  }
  return acc
}

const allCode = CODE_ROOTS.flatMap(r => codeSources(join(ROOT, r)))
const rel = (f: string) => f.replace(ROOT, '')

describe('реквизиты издателя — один источник (#297)', () => {
  it('ни один файл кода не держит собственную копию', () => {
    // Телефон в двух формах: человеческая копия и `tel:`-копия разъезжаются независимо.
    // Сервер сканируется наравне с приложением: шаблон письма или issue с реквизитами — ровно
    // то место, куда копия вернётся следующей.
    const literals = [PUBLISHER.unp, PUBLISHER.email, PUBLISHER.phone, PUBLISHER.phoneTel, PUBLISHER.telegram]
    const offenders: string[] = []
    for (const file of allCode) {
      const text = readFileSync(file, 'utf8')
      for (const literal of literals) {
        if (text.includes(literal)) offenders.push(`${rel(file)} → «${literal}»`)
      }
    }
    expect(offenders, `реквизиты берём из ${SOURCE_FILE}, а не переписываем:\n${offenders.join('\n')}`).toEqual([])
  })

  it('короткое имя издателя пишется ровно одним способом — в коде', () => {
    // Прежнее расхождение: «И.С.» без пробела в landing.ts против «И. С.» в футере и на визитке.
    expect(LANDING_PUBLISHER).toBe(PUBLISHER.shortName)
    const spellings = new Set<string>()
    for (const file of allCode) {
      // Бэктик в стоп-символах: без него совпадение в шаблонной строке утащило бы весь хвост.
      for (const m of readFileSync(file, 'utf8').matchAll(/ИП Шевчик[^'"`«»\n]*/g)) spellings.add(m[0].trim())
    }
    expect([...spellings], 'в исходниках осталось написание имени издателя мимо PUBLISHER.shortName').toEqual([])
  })

  it('юридические документы называют издателя так же, как код', () => {
    // Цитировать реквизиты документу можно и нужно — а вот звать правообладателя иначе, чем сайт,
    // нельзя: именно это расхождение (сайт против прежних документов на dl.bx-shef.by) и завело #297.
    const wrong: string[] = []
    for (const doc of LEGAL_DOCS) {
      // Сверяем НАЧАЛО совпадения, а не всю строку: за именем в документе идёт живой текст
      // («ИП Шевчик И. С. — издатель»), и обрезка хвоста по знакам препинания съедала бы точку
      // в самих инициалах. Именно её отсутствие («И.С.») и есть то расхождение, которое ловим.
      for (const m of readFileSync(join(ROOT, doc), 'utf8').matchAll(/ИП Шевчик[^\n]*/g)) {
        const head = m[0].slice(0, PUBLISHER.shortName.length)
        if (head !== PUBLISHER.shortName) wrong.push(`${doc} → «${head}»`)
      }
    }
    expect(wrong, `в документах издатель назван иначе, чем в app/config/publisher.ts:\n${wrong.join('\n')}`).toEqual([])
  })

  it('лицензия называет правообладателя ровно так, как источник', () => {
    // Полное юридическое имя и адрес — это то, чем документ идентифицирует лицензиара; расхождение
    // с кодом здесь дороже любого другого: на сайте одно лицо, в договоре другое.
    const eula = readFileSync(join(ROOT, 'docs/eula.md'), 'utf8')
    expect(eula).toContain(PUBLISHER.legalName)
    expect(eula).toContain(PUBLISHER.address)
    expect(eula).toContain(PUBLISHER.unp)
    expect(eula).toContain(PUBLISHER.email)
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
