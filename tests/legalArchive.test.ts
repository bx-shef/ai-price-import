import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LEGAL_ARCHIVE } from '../app/config/legalArchive'
import { allArchiveRoutes, archivePath, editionCanonicalPath, editionPageTitle, editionPath, findArchiveDoc, findEdition, isCurrentEdition, supersededLabel } from '../app/utils/legalArchive'
import { parseLegalEdition } from '../app/utils/legalEdition'
import { buildSitemapXml } from '../server/utils/seoFiles'

// #415. Архив существует ради одного утверждения: «вот текст, который действовал в тот день».
// Поэтому проверяется не наличие страниц, а то, что утверждение остаётся правдой.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8')

describe('#415: снимок действующей редакции совпадает с живым документом', () => {
  for (const doc of LEGAL_ARCHIVE) {
    const current = doc.editions.find(isCurrentEdition)
    it(`${doc.slug}: файл редакции = байт в байт docs/${doc.sourceFile}.md`, () => {
      // ⚠ Главный гард задачи. Пока редакция действующая, у документа ДВЕ копии: живая (её
      // рендерит `/eula`) и снимок в архиве (его рендерит постоянная ссылка). Разъехавшись, они
      // сделают ровно то, ради предотвращения чего архив и заведён: страница покажет один текст,
      // а «редакция от 08.08.2026» по постоянному адресу — другой, и оба будут выглядеть
      // официальными. Дублирование здесь неизбежно (закрытый репозиторий доказательством не
      // является), поэтому его сторожит равенство, а не аккуратность правящего.
      expect(current, `${doc.slug}: нет действующей редакции`).toBeTruthy()
      const snapshot = read(`docs/archive/${doc.slug}/${current!.date}.md`)
      const live = read(`docs/${doc.sourceFile}.md`)
      expect(snapshot).toBe(live)
    })

    it(`${doc.slug}: дата вступления в реестре совпадает с текстом документа`, () => {
      // Реестр — вторая копия дат, и она обязана сходиться с самим документом: разъехавшись, архив
      // назвал бы период действия, которого в тексте нет.
      const ed = parseLegalEdition(read(`docs/${doc.sourceFile}.md`), doc.sourceFile)
      expect(current!.effective).toBe(ed.effective)
      // Дата редакции в имени файла — ISO, в тексте — ДД.ММ.ГГГГ. Сверяем как даты, а не строки.
      const [d, m, y] = ed.edition.split('.')
      expect(current!.date).toBe(`${y}-${m}-${d}`)
    })
  }
})

describe('#415: неизменяемость и целостность архива', () => {
  it('у каждого документа РОВНО ОДНА действующая редакция', () => {
    // Публикация новой редакции — пять шагов, и один из них («проставить дату замены прежней»)
    // при забывании не ломал НИЧЕГО: у двух записей `supersededAt: null`, `find` берёт новую,
    // байт-равенство и даты сходятся, тесты зелены. А на страницах обе редакции помечены
    // действующими, и заменённая по постоянному адресу утверждает «Действующая редакция» над
    // текстом, который больше не в силе. Это единственная ошибка публикации без громкого отказа.
    for (const doc of LEGAL_ARCHIVE) {
      const current = doc.editions.filter(isCurrentEdition)
      expect(current.length, `${doc.slug}: действующих редакций ${current.length}, а должна быть одна`).toBe(1)
    }
  })

  it('текст КАЖДОЙ редакции совпадает со своим отпечатком', () => {
    // Байт-равенство сверяет снимок с живым документом и только пока редакция действующая. У
    // заменённой сверять не с чем — её файл можно было править задним числом при зелёном CI, ровно
    // то, что шапка реестра запрещает. Отпечаток ловит и правку ещё-действующей редакции без смены
    // даты: там менялись ОБЕ копии сразу, и равенство молчало.
    for (const doc of LEGAL_ARCHIVE) {
      for (const e of doc.editions) {
        const bytes = readFileSync(resolve(ROOT, `docs/archive/${doc.slug}/${e.date}.md`))
        const got = createHash('sha256').update(bytes).digest('hex')
        expect(got, `${doc.slug}/${e.date}: текст редакции изменился после публикации`).toBe(e.sha256)
      }
    }
  })

  it('в docs/archive нет файлов вне реестра и папок вне списка документов', () => {
    // Обратная сторона: снимок без строки в реестре не получает ни маршрута, ни места в карте
    // сайта — «архивная редакция», которой нет ни по одному адресу. Реестр был и данными, и
    // оракулом теста, поэтому пропажу видно не было.
    expect(readdirSync(resolve(ROOT, 'docs/archive')).sort()).toEqual(LEGAL_ARCHIVE.map(d => d.slug).sort())
    for (const doc of LEGAL_ARCHIVE) {
      expect(readdirSync(resolve(ROOT, `docs/archive/${doc.slug}`)).sort())
        .toEqual(doc.editions.map(e => `${e.date}.md`).sort())
    }
  })
})

describe('#415: страницы и адреса', () => {
  it('у каждого документа есть архив и страница редакции', () => {
    for (const doc of LEGAL_ARCHIVE) {
      expect(existsSync(resolve(ROOT, `app/pages/${doc.slug}/archive/index.vue`)), `${doc.slug}: нет архива`).toBe(true)
      expect(existsSync(resolve(ROOT, `app/pages/${doc.slug}/archive/[date].vue`)), `${doc.slug}: нет страницы редакции`).toBe(true)
      expect(existsSync(resolve(ROOT, `app/pages/${doc.slug}/index.vue`)), `${doc.slug}: нет действующей страницы`).toBe(true)
    }
  })

  it('каждая объявленная редакция имеет файл текста', () => {
    // Строка в реестре без файла — постоянная ссылка в 404, то есть ровно то обещание, которое
    // архив и даёт («ссылка не меняется никогда»), нарушенное в момент публикации.
    for (const doc of LEGAL_ARCHIVE) {
      for (const e of doc.editions) {
        expect(existsSync(resolve(ROOT, `docs/archive/${doc.slug}/${e.date}.md`)), `${doc.slug}/${e.date}: нет файла`).toBe(true)
      }
    }
  })

  it('все адреса архива пререндерятся и попадают в карту сайта', () => {
    // Иначе новая редакция появлялась бы в списке, но её адрес отдавал бы 404 — и узнали бы об
    // этом ровно тогда, когда ссылку открыл юрист другой стороны.
    //
    // ⚠ Проверяем СОДЕРЖИМОЕ массива маршрутов, а не наличие строки в файле: первая версия искала
    // `allArchiveRoutes()` по всему `nuxt.config.ts`, и мутация «убрать вызов из массива, оставив
    // упоминание в комментарии» проходила — гард сторожил, что файл помнит про хелпер.
    const nuxt = read('nuxt.config.ts')
    const routes = /routes:\s*\[([\s\S]*?)\]/.exec(nuxt)?.[1] ?? ''
    expect(routes, 'адреса архива не попали в список пререндера').toContain('allArchiveRoutes()')
    // Карта сайта проверяется поведением, а не текстом.
    const xml = buildSitemapXml('https://x.test', '2026-08-04')
    for (const r of allArchiveRoutes()) expect(xml).toContain(`<loc>https://x.test${r}</loc>`)
  })

  it('адреса строятся одним способом', () => {
    expect(archivePath('eula')).toBe('/eula/archive')
    expect(editionPath('eula', '2026-08-08')).toBe('/eula/archive/2026-08-08')
    expect(allArchiveRoutes()).toContain('/site-privacy/archive/2026-08-08')
    // 4 документа × (архив + по редакции)
    expect(allArchiveRoutes().length).toBe(LEGAL_ARCHIVE.length + LEGAL_ARCHIVE.reduce((n, d) => n + d.editions.length, 0))
  })

  it('неизвестный документ и неизвестная дата — null, а не подстановка соседа', () => {
    // Постоянная ссылка, ведущая на ЧУЖУЮ редакцию, хуже честной пустой страницы: человек прочтёт
    // не тот текст и не заметит подмены.
    expect(findArchiveDoc('nope')).toBeNull()
    expect(findEdition('eula', '1999-01-01')).toBeNull()
    expect(findEdition('nope', '2026-08-08')).toBeNull()
  })
})

describe('#415: действующая редакция отличима от архивной', () => {
  it('признак берётся из данных, а не из порядка и не из часов', () => {
    // «Первая в списке» — это порядок вывода, он не обязан совпадать со смыслом; сравнение с
    // «сегодня» привязало бы страницу к часам сервера, а редакция становится недействующей не в
    // полночь, а когда издатель опубликовал замену.
    expect(isCurrentEdition({ date: '2026-08-08', effective: '20.08.2026', supersededAt: null })).toBe(true)
    expect(isCurrentEdition({ date: '2026-08-08', effective: '20.08.2026', supersededAt: '01.01.2027' })).toBe(false)
    const util = read('app/utils/legalArchive.ts')
    expect(util, 'признак действующей выводится из даты «сегодня»').not.toMatch(/Date\.now|new Date\(\)/)
  })

  it('у действующей в таблице прочерк, у архивной — дата замены', () => {
    expect(supersededLabel({ date: 'x', effective: 'y', supersededAt: null })).toBe('—')
    expect(supersededLabel({ date: 'x', effective: 'y', supersededAt: '01.01.2027' })).toBe('01.01.2027')
  })

  it('страница редакции помечает архивную и уводит на действующую', () => {
    const cmp = read('app/components/LegalDocument.vue')
    expect(cmp).toMatch(/Архивная редакция/)
    expect(cmp).toMatch(/Действующая редакция/)
    expect(cmp).toMatch(/Открыть действующую редакцию/)
  })

  it('список помечает действующую УСЛОВНО, а не всех подряд', () => {
    // Мутация «убрать `v-if`, оставив слово» помечала действующими ВСЕ редакции, включая
    // заменённые, — ту самую путаницу, ради предотвращения которой архив и заведён, — и проходила:
    // гард проверял, что слово есть в шаблоне.
    const cmp = read('app/components/LegalArchiveIndex.vue')
    expect(cmp).toMatch(/v-if="isCurrentEdition\(e\)"[\s\S]{0,80}действующая/)
  })
})

describe('#415: страница не обещает больше самого документа', () => {
  it('флаг «нет обратной силы» совпадает с текстом документа', () => {
    // Все четыре страницы архива печатали, что изменения не имеют обратной силы. В `site-terms.md`
    // и `site-privacy.md` такого пункта нет вовсе — раздел об изменениях это публикация,
    // вступление в силу и архив. Печатать за издателя обязательство сильнее, чем в самом
    // документе, хуже, чем не печатать ничего.
    for (const doc of LEGAL_ARCHIVE) {
      const says = /не имеют обратной силы/.test(read(`docs/${doc.sourceFile}.md`))
      expect(doc.noRetroactivity, `${doc.slug}: флаг разошёлся с документом`).toBe(says)
    }
  })

  it('текст выводится условно', () => {
    expect(read('app/components/LegalArchiveIndex.vue')).toMatch(/v-if="doc\?\.noRetroactivity"/)
  })
})

describe('#415: перекрёстные ссылки', () => {
  it('с каждой действующей страницы есть ссылка в архив', () => {
    for (const doc of LEGAL_ARCHIVE) {
      // ⚠ Считаем ВСЕ вхождения: `toContain` не отличал «стоит правильный слаг» от «стоит
      // правильный и рядом ещё один, чужой» — страница с двумя атрибутами проходила.
      const found = [...read(`app/pages/${doc.slug}/index.vue`).matchAll(/archive-slug="([^"]*)"/g)].map(m => m[1])
      expect(found, `${doc.slug}: ссылка в архив должна быть ровно одна и своя`).toEqual([doc.slug])
    }
    expect(read('app/components/LegalDocument.vue')).toContain('Все редакции документа')
  })

  it('из архива есть путь обратно к действующей редакции', () => {
    expect(read('app/components/LegalArchiveIndex.vue')).toMatch(/К действующей редакции/)
  })

  it('сами документы обещают архив по этим адресам', () => {
    // Обещание напечатано в опубликованном тексте (п. 9.3.8 EULA и соседние). Адрес в документе и
    // адрес страницы — две копии; разъехавшись, документ сошлётся в никуда.
    const promises: Array<[string, string]> = [
      ['docs/eula.md', '/eula/archive'],
      ['docs/privacy-policy.md', '/privacy/archive'],
      ['docs/site-terms.md', '/site-terms/archive'],
      ['docs/site-privacy.md', '/site-privacy/archive']
    ]
    for (const [file, path] of promises) {
      // ⚠ Граница, а не подстрока: `contains('/eula/archive')` довольствовался и `/eula/archives`,
      // и `/eula/archive.html` — то есть обещанием, ведущим в 404.
      const re = new RegExp(`${path.replace(/\//g, '\\/')}(?![\\w./-])`)
      expect(read(file), `${file}: не обещает архив по адресу ${path}`).toMatch(re)
    }
  })
})

// ⚠ Блок заведён по результату мутационной проверки: пять правок ниже переживали ВЕСЬ набор тестов.
// Общая черта у всех — правило жило либо в `computed` компонента, либо в атрибуте шаблона, либо
// только в комментарии, и ни один тест о нём не спрашивал.
describe('#415: правила страниц редакции (пережили мутации)', () => {
  it('канонический адрес: у действующей — сам документ, у заменённой — свой', () => {
    const doc = LEGAL_ARCHIVE[0]!
    const current = doc.editions.find(isCurrentEdition)!
    expect(editionCanonicalPath(doc.slug, current.date, current)).toBe(`/${doc.slug}`)
    // Заменённой редакции в реестре пока нет — строим её из действующей: инвариант заявлен над
    // признаком `supersededAt`, а не над сегодняшним составом данных.
    const retired = { ...current, supersededAt: '01.01.2030' }
    expect(editionCanonicalPath(doc.slug, retired.date, retired)).toBe(editionPath(doc.slug, retired.date))
  })

  it('заголовок страницы редакции отличается от заголовка документа', () => {
    const doc = LEGAL_ARCHIVE[0]!
    const e = doc.editions[0]!
    expect(editionPageTitle(doc.title)).toBe(doc.title)
    expect(editionPageTitle(doc.title, e)).not.toBe(doc.title)
    expect(editionPageTitle(doc.title, e)).toContain(e.date)
  })

  it('неизвестная редакция — настоящий 404, а не страница с кодом 200', () => {
    // Мягкий 404 под индексируемым префиксом даёт неограниченное множество страниц в выдаче.
    const src = read('app/components/LegalEditionPage.vue')
    const throws = src.match(/createError\(\{[^}]*\}\)/g) ?? []
    expect(throws, 'нужны оба отказа: нет редакции и нет текста').toHaveLength(2)
    for (const t of throws) {
      expect(t, 'отказ должен быть 404').toMatch(/statusCode:\s*404/)
      // ⚠ Без `fatal` брошенная из асинхронного `setup` ошибка отвергает Suspense, а не уходит в
      // обработчик Nuxt: переход по битой ссылке внутри приложения давал пустую страницу с кодом 200.
      expect(t, 'отказ должен быть fatal — иначе при переходе внутри приложения будет пустая страница').toMatch(/fatal:\s*true/)
    }
  })

  it('тексты редакций грузятся по требованию', () => {
    // `eager: true` затащил бы в чанк одной страницы тексты ВСЕХ редакций всех четырёх документов.
    // Проверяем отсутствие ключа в самих опциях глоба, а не в комментарии рядом.
    const opts = read('app/utils/legalArchiveTexts.ts').match(/import\.meta\.glob\([^)]*\)/s)?.[0] ?? ''
    expect(opts, 'глоб не найден — гард потерял смысл').toContain('docs/archive')
    expect(opts).not.toMatch(/\beager\b/)
  })

  it('строки таблицы архива несут заголовок строки', () => {
    // Без `th scope="row"` экранный диктор объявляет четыре одинаковых «Открыть» без признака,
    // к какой редакции они ведут, — список ссылок в никуда.
    expect(read('app/components/LegalArchiveIndex.vue')).toMatch(/<th scope="row">/)
  })
})

// ⚠ Второй блок по итогам разбора публикации: у шагов проверялось НАЛИЧИЕ, но не ЗНАЧЕНИЕ. Дата
// замены и даты заменённых редакций не сверялись ни с чем — опечатка давала архив, объявляющий
// период действия, которого не было, при зелёном CI и на постоянном адресе.
describe('#415: значения дат в реестре', () => {
  const RU_DATE = /^\d{2}\.\d{2}\.\d{4}$/

  it('дата замены — это дата вступления следующей редакции', () => {
    // Список идёт новыми вверх, поэтому «следующая» для записи i — это запись i-1.
    for (const doc of LEGAL_ARCHIVE) {
      doc.editions.forEach((e, i) => {
        if (isCurrentEdition(e)) return
        expect(e.supersededAt, `${doc.slug}/${e.date}: дата замены не в формате ДД.ММ.ГГГГ`).toMatch(RU_DATE)
        const next = doc.editions[i - 1]
        expect(next, `${doc.slug}/${e.date}: редакция заменена, а заменившей в реестре нет`).toBeTruthy()
        expect(e.supersededAt, `${doc.slug}/${e.date}: замена не совпадает с вступлением следующей`).toBe(next!.effective)
      })
    }
  })

  it('даты КАЖДОЙ редакции совпадают с текстом её снимка', () => {
    // Прежняя сверка читала живой документ и потому касалась только действующей редакции. У
    // заменённой источник свой — сам снимок, он и есть опубликованный текст.
    for (const doc of LEGAL_ARCHIVE) {
      for (const e of doc.editions) {
        const ed = parseLegalEdition(read(`docs/archive/${doc.slug}/${e.date}.md`), `${doc.slug}/${e.date}`)
        expect(e.effective, `${doc.slug}/${e.date}: вступление в реестре ≠ тексту снимка`).toBe(ed.effective)
        const [d, m, y] = ed.edition.split('.')
        expect(e.date, `${doc.slug}/${e.date}: дата редакции в реестре ≠ тексту снимка`).toBe(`${y}-${m}-${d}`)
      }
    }
  })
})

describe('#415: таблица архива доступна с клавиатуры', () => {
  it('прокручиваемая область фокусируема и названа', () => {
    // Без фокуса до ссылки «Открыть» (она в колонке за краем экрана) с клавиатуры не добраться.
    const src = read('app/components/LegalArchiveIndex.vue')
    const region = src.match(/<div[^>]*class="archive-scroll"[^>]*>/s)?.[0] ?? ''
    expect(region, 'обёртка прокрутки не найдена').toBeTruthy()
    expect(region).toContain('tabindex="0"')
    expect(region).toContain('role="region"')
    expect(region).toMatch(/aria-label/)
  })
})
