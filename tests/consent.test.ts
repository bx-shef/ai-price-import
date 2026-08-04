import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseLegalEdition } from '../app/utils/legalEdition'
import { consentGate, CONSENT_REQUIRED_MESSAGE } from '../server/utils/consentGate'
import { getConsent, recordConsent } from '../server/utils/consentStore'
import { appScreenState } from '../app/utils/appScreenState'

// #414. Экран согласия — единственное место во всём юридическом пакете, где конструкция держится
// на элементе интерфейса, поэтому проверяется не «экран есть», а три отдельных утверждения:
// что записывается, кто вправе записать и что происходит без записи.

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')

describe('#414: издание документа читается из самого документа', () => {
  it('обе даты достаются из опубликованных документов приложения', () => {
    for (const doc of ['../docs/eula.md', '../docs/privacy-policy.md']) {
      const ed = parseLegalEdition(read(doc), doc)
      expect(ed.edition).toMatch(/^\d{2}\.\d{2}\.\d{4}$/)
      expect(ed.effective).toMatch(/^\d{2}\.\d{2}\.\d{4}$/)
    }
  })

  it('документ без даты — жёсткая ошибка, а не пустая строка', () => {
    // Молчаливый `null` уехал бы в запись о согласии пустым полем, и доказательство превратилось
    // бы в «принял неизвестно что» — ровно то, ради чего запись существует.
    expect(() => parseLegalEdition('# Документ\n\nбез дат', 'x.md')).toThrow(/редакции/)
    expect(() => parseLegalEdition('**Редакция от:** 08.08.2026', 'x.md')).toThrow(/в силу/)
  })
})

describe('#414: гейт приёма документов', () => {
  it('без записи о согласии документы не принимаются', () => {
    const d = consentGate(null)
    expect(d.allowed).toBe(false)
    expect(d.status).toBe(403)
    expect(d.message).toBe(CONSENT_REQUIRED_MESSAGE)
  })

  it('с записью — принимаются', () => {
    expect(consentGate({ acceptedAt: new Date(), eulaEdition: '08.08.2026', privacyEdition: '08.08.2026' }).allowed).toBe(true)
  })

  it('текст отказа говорит, ЧТО сделать и КОМУ', () => {
    // «Доступ запрещён» отправило бы сотрудника писать в поддержку. Чинит это администратор, и
    // одним действием — поэтому оба слова обязаны быть в тексте.
    expect(CONSENT_REQUIRED_MESSAGE).toMatch(/администратор/i)
    expect(CONSENT_REQUIRED_MESSAGE).toMatch(/Лицензионное соглашение/)
  })

  it('роут загрузки реально зовёт гейт — и до чтения тела', () => {
    // Мутация «убрать вызов из роута» не роняет ни один тест выше: гейт покрыт в изоляции, а его
    // вызов не проверял никто. Порядок важен не меньше: гейт после буферизации тела означал бы, что
    // документ уже прочитан в память, а сразу за этим — что он ушёл бы на инференс.
    const route = read('../server/api/import/upload.post.ts')
    const gateAt = route.indexOf('consentGate(')
    const bodyAt = route.indexOf('readMultipartFormData')
    expect(gateAt, 'гейт согласия не вызывается').toBeGreaterThan(-1)
    expect(bodyAt).toBeGreaterThan(-1)
    expect(gateAt < bodyAt, 'тело читается до проверки согласия').toBe(true)
  })
})

describe('#414: запись о согласии', () => {
  interface Row { member_id: string, eula_edition: string, privacy_edition: string, accepted_at: Date }
  function memoryDb() {
    const rows: Row[] = []
    const query = async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('SELECT')) {
        const r = rows.find(x => x.member_id === params[0])
        return { rows: r ? [r] : [] }
      }
      if (sql.trim().startsWith('INSERT')) {
        const [id, eula, privacy] = params as string[]
        const existing = rows.find(x => x.member_id === id)
        // ⚠ Фейк ИСПОЛНЯЕТ конфликт-ветку из самого SQL, а не реализует её по памяти автора теста.
        // Первая версия зашивала «DO NOTHING» в фейк — и мутация «переписать стор на DO UPDATE»
        // проходила при зелёном тесте: проверялся фейк, а не запрос, который уйдёт в Postgres.
        if (!existing) {
          rows.push({ member_id: id!, eula_edition: eula!, privacy_edition: privacy!, accepted_at: new Date(rows.length) })
        } else if (/DO UPDATE/i.test(sql)) {
          existing.eula_edition = eula!
          existing.privacy_edition = privacy!
          existing.accepted_at = new Date(rows.length + 100)
        } else if (!/DO NOTHING/i.test(sql)) {
          throw new Error('INSERT без ON CONFLICT — нарушение первичного ключа')
        }
        return { rows: [] }
      }
      return { rows: [] }
    }
    return { rows, query: query as never }
  }

  const editions = {
    eula: { edition: '08.08.2026', effective: '20.08.2026' },
    privacy: { edition: '08.08.2026', effective: '20.08.2026' }
  }

  it('пишет редакции, по которым потом видно, ЧТО именно приняли', async () => {
    const db = memoryDb()
    await recordConsent('m1', editions, db.query)
    const got = await getConsent('m1', db.query)
    expect(got?.eulaEdition).toBe('08.08.2026')
    expect(got?.privacyEdition).toBe('08.08.2026')
  })

  it('повторное нажатие НЕ переписывает первую запись', async () => {
    // Силу имеет первое согласие, и на его дату потом ссылаются. Перезапись молча сдвигала бы
    // доказательство вперёд — а в споре важно, что условия приняли ДО первого документа.
    const db = memoryDb()
    await recordConsent('m1', editions, db.query)
    const first = (await getConsent('m1', db.query))!.acceptedAt
    await recordConsent('m1', { eula: { edition: '01.01.2027', effective: '01.01.2027' }, privacy: editions.privacy }, db.query)
    const after = (await getConsent('m1', db.query))!
    expect(after.acceptedAt).toEqual(first)
    expect(after.eulaEdition, 'редакция перезаписана').toBe('08.08.2026')
    expect(db.rows.length).toBe(1)
  })

  it('нет строки — нет согласия', async () => {
    const db = memoryDb()
    expect(await getConsent('unknown', db.query)).toBeNull()
  })

  it('в записи нет и не может быть идентификатора сотрудника', () => {
    // Лицензиат — организация (п. 2.7 EULA). Столбца под сотрудника нет в схеме, и запись его не
    // принимает: гард держит именно состав данных, а не текст комментария рядом.
    const schema = read('../server/db/schema.ts')
    const table = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS portal_consent'))
    const body = table.slice(0, table.indexOf(');'))
    expect(body).not.toMatch(/user_id|user_?name|employee|accepted_by/i)
    expect(read('../server/utils/consentStore.ts')).not.toMatch(/userId/)
    expect(read('../server/api/consent.post.ts'), 'роут кладёт id сотрудника в запись').not.toMatch(/member\.userId/)
  })

  it('редакции берутся у сервера, а не из тела запроса', () => {
    // Доказательство, содержание которого диктует проверяемая сторона, ничего не стоит: клиент,
    // приславший `{eula:'01.01.2020'}`, задним числом «согласился» с редакцией, которой не видел.
    const route = read('../server/api/consent.post.ts')
    expect(route).toContain('currentEditions()')
    expect(route, 'роут читает тело запроса').not.toMatch(/readBody|readValidatedBody/)
  })

  it('согласие уходит вместе с порталом', () => {
    // Согласие дано на установку, а не навсегда: после переустановки его берут заново, иначе новый
    // владелец портала оказался бы связан галочкой предыдущего.
    expect(read('../server/utils/tokenStore.ts')).toMatch(/'portal_consent'/)
  })
})

describe('#414: кто вправе принять', () => {
  it('запись гейтится на администратора портала', () => {
    const route = read('../server/api/consent.post.ts')
    expect(route).toMatch(/if \(!member\.admin\)/)
    expect(route).toMatch(/403/)
  })
})

describe('#414: экран согласия стоит перед настройкой', () => {
  const base = { launch: 'work' as const, settingsResolved: true, needsSetup: true }

  it('нет согласия → экран согласия, а не настройка', () => {
    expect(appScreenState({ ...base, consentResolved: true, consentAccepted: false })).toBe('consent')
  })

  it('пока согласие не проверено — загрузка, а не экран согласия', () => {
    // Мелькнувший экран согласия у портала, который его давно принял, читается как сброс настроек.
    expect(appScreenState({ ...base, consentResolved: false, consentAccepted: false })).toBe('loading')
  })

  it('согласие есть → дальше как раньше', () => {
    expect(appScreenState({ ...base, consentResolved: true, consentAccepted: true })).toBe('setup')
    expect(appScreenState({ ...base, needsSetup: false, consentResolved: true, consentAccepted: true })).toBe('work')
  })

  it('пусковая страница согласия не спрашивает', () => {
    // В базовом фрейме рабочий экран не поднимается вовсе — там нечего гейтить, и лишний запрос
    // крутился бы в двух фреймах сразу (#262).
    expect(appScreenState({ ...base, launch: 'launcher', consentResolved: false, consentAccepted: false })).toBe('launcher')
  })
})

describe('#414: экран показывает то, о чём потом скажут «не видел»', () => {
  const screen = read('../app/components/ConsentScreen.vue')

  it('названы обе юрисдикции инференса', () => {
    expect(screen).toMatch(/Российская Федерация/)
    expect(screen).toMatch(/Китайской Народной Республики/)
  })

  it('сказано про обучение моделей провайдером', () => {
    expect(screen).toMatch(/обучения своих моделей/)
  })

  it('обе ссылки открываются в новой вкладке и ведут на действующие документы', () => {
    expect(screen).toMatch(/to="\/eula"/)
    expect(screen).toMatch(/to="\/privacy"/)
    expect([...screen.matchAll(/target="_blank"/g)].length).toBeGreaterThanOrEqual(2)
  })

  it('галочка не отмечена заранее, а кнопка без неё не нажимается', () => {
    // Предотмеченная галочка не является подтверждением ни по смыслу, ни по любому разумному
    // прочтению — а именно на это подтверждение опирается гарантия прав перед провайдером.
    expect(screen).toMatch(/const agreed = ref\(false\)/)
    expect(screen).toMatch(/:disabled="!agreed \|\| props\.saving"/)
  })

  it('текст галочки цитирует пункт соглашения, который она реализует', () => {
    expect(screen).toMatch(/п\. 4\.3\.2/)
  })
})
