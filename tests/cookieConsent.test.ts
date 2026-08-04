import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CONSENT_KEY, CONSENT_PATHS, CONSENT_VERSION } from '../app/config/cookieConsent'
import { analyticsAllowed, isConsentPath, parseConsent, serializeConsent } from '../app/utils/cookieConsent'
import { allArchiveRoutes } from '../app/utils/legalArchive'
import { buildSitemapXml } from '../server/utils/seoFiles'

// #404. Уведомление о cookie и гейт аналитики.
//
// Главное утверждение задачи проверяемо в одно действие: до нажатия «Согласен» к счётчику не должно
// быть ни одного обращения. Здесь проверяется то, от чего это зависит: разбор решения, где баннер
// показывается, и что сниппет счётчика сам себя не запускает.

const ROOT = new URL('../', import.meta.url).pathname
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

describe('#404: разбор решения', () => {
  it('свой же формат читается обратно', () => {
    expect(parseConsent(serializeConsent('accepted'))).toBe('accepted')
    expect(parseConsent(serializeConsent('declined'))).toBe('declined')
  })

  it('мусор и пустота — «не отвечал», а НЕ согласие', () => {
    // Цена ошибки несимметрична: лишний показ баннера — неудобство, аналитика без согласия —
    // нарушение собственного документа. Поэтому любое непонятное значение читается в свою сторону.
    for (const bad of [null, undefined, '', 'yes', '{', '{"choice":"accepted"}', '{"choice":"maybe","version":1}', '[]', 'null']) {
      expect(parseConsent(bad as string | null), String(bad)).toBeNull()
    }
  })

  it('чужая версия вопроса — спрашиваем заново', () => {
    // Версия меняется, когда меняется СМЫСЛ вопроса (новый приёмник, новая категория файлов): тогда
    // прежний ответ отвечает не на него.
    expect(parseConsent(JSON.stringify({ choice: 'accepted', version: CONSENT_VERSION + 1 }))).toBeNull()
    expect(parseConsent(JSON.stringify({ choice: 'accepted', version: CONSENT_VERSION - 1 }))).toBeNull()
  })

  it('аналитика — только по явному согласию', () => {
    expect(analyticsAllowed('accepted')).toBe(true)
    expect(analyticsAllowed('declined')).toBe(false)
    expect(analyticsAllowed(null)).toBe(false)
  })
})

describe('#404: где показывается', () => {
  it('каждый публичный адрес из карты сайта показывает уведомление', () => {
    // ⚠ Оракул НЕЗАВИСИМЫЙ. Прежняя проверка перебирала сам `CONSENT_PATHS` и была истинной по
    // построению: список выводится из реестра, поэтому цикл по нему зелен при любом содержимом.
    // Дефект, ради которого всё и правилось (публичная страница без баннера), она больше не
    // сторожила. Карта сайта — второй, независимо составленный перечень публичных адресов: новая
    // публичная страница попадает туда, и рассинхрон становится виден.
    const xml = buildSitemapXml('https://price-import.bx-shef.by')
    const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => new URL(m[1]!).pathname)
    expect(urls.length, 'карта сайта пуста — оракул потерял смысл').toBeGreaterThan(4)
    const missing = urls.filter(u => !isConsentPath(u))
    expect(missing, `публичные адреса без уведомления о cookie:\n${missing.join('\n')}`).toEqual([])
  })

  it('ни на одном экране внутри портала — нет', () => {
    // Внутри фрейма Битрикса баннер бессмыслен (согласие даёт портал) и закроет рабочий экран.
    for (const p of ['/app', '/settings', '/metrics', '/import', '/install', '/login', '/queues']) {
      expect(isConsentPath(p), p).toBe(false)
    }
  })

  it('хвостовой слэш и строка запроса не меняют решения', () => {
    // Хвостовой слэш у Nuxt появляется и исчезает между пререндером и переходом внутри приложения —
    // на этой мелочи баннер пропадал бы ровно на половине заходов.
    expect(isConsentPath('/eula/')).toBe(true)
    expect(isConsentPath('/?utm_source=ya')).toBe(true)
    expect(isConsentPath('/privacy#p5')).toBe(true)
    // Регистр тоже: vue-router отдаёт ту же страницу на `/EULA`, а путь остаётся с заглавными.
    expect(isConsentPath('/EULA')).toBe(true)
    expect(isConsentPath('/app')).toBe(false)
  })

  it('страницы архива редакций — тоже публичные', () => {
    // Двенадцать адресов, которые рукописный список пропустил: они пререндерятся, лежат в карте
    // сайта и открываются прямо из поиска. Посетитель читал бы там «счётчик только после согласия»,
    // не видя, где это согласие дать. Список выводится из реестра, поэтому новая редакция
    // добавляет свои адреса сама.
    expect(isConsentPath('/site-privacy/archive')).toBe(true)
    expect(isConsentPath('/eula/archive/2026-08-08')).toBe(true)
    for (const r of allArchiveRoutes()) expect(isConsentPath(r), r).toBe(true)
  })
})

describe('#404: счётчик не стартует сам', () => {
  const config = read('nuxt.config.ts')

  it('сниппет объявляет функцию, а не запускает счётчик безусловно', () => {
    // Инвариант приёмки: «до клика запроса к счётчику нет». Держится он на том, что создание тега
    // живёт ВНУТРИ функции, а вызов — под проверкой сохранённого согласия.
    const declAt = config.indexOf('window.__ymStart=function')
    const tagAt = config.indexOf('mc.yandex.ru/metrika/tag.js')
    expect(declAt, 'функция запуска не найдена').toBeGreaterThan(-1)
    expect(tagAt > declAt, 'тег создаётся вне функции запуска').toBe(true)
    // Единственный самостоятельный вызов — под проверкой согласия.
    expect(config).toMatch(/choice==='accepted'/)
  })

  it('решение читается из того же ключа и той же версии, что и приложение', () => {
    // Сниппет — простой текст в конфиге, он не может импортировать наши модули, поэтому ключ и
    // версия в нём написаны заново. Разъехавшись, они дали бы согласие, которое счётчик не видит.
    // ⚠ Сверяем с самой константой И по границе. Подстрочная проверка `toContain('cookie-consent')`
    // пропускала мутацию `cookie-consent-v2`: приложение писало бы в один ключ, сниппет читал бы
    // другой, и счётчик не поднимался бы никогда после перезагрузки — при зелёном CI.
    expect(config).toContain(`getItem('${CONSENT_KEY}')`)
    expect(config).toContain(`c.version===${CONSENT_VERSION}`)
  })

  it('чтение хранилища не может уронить весь инлайн-скрипт', () => {
    // `localStorage` бросает в приватном режиме части браузеров; исключение снесло бы и объявление
    // функции — счётчик не заработал бы уже никогда, даже после согласия.
    expect(config).toMatch(/try\{[^}]*localStorage/)
  })
})

describe('#404: баннер', () => {
  const banner = read('app/components/CookieBanner.vue')

  it('оболочка берётся из общего источника, а не пишется заново', () => {
    // Половину пары «фон + цвет текста» уже один раз забыли скопировать, и юридические страницы
    // вышли чёрным по чёрному (#368).
    expect(banner).toContain('landingShell')
    expect(banner).toMatch(/var\(--legal-text\)/)
  })

  it('есть ответ «только необходимые», а не одна кнопка согласия', () => {
    // Одна кнопка означает, что выбора нет, а вопрос задан.
    expect(banner).toMatch(/decide\('declined'\)/)
    expect(banner).toMatch(/decide\('accepted'\)/)
  })

  it('ссылка ведёт на политику САЙТА, а не приложения', () => {
    // Посетитель лендинга приложение не устанавливал: у него другой документ и другой состав данных.
    expect(read('app/config/cookieConsent.ts')).toContain('/site-privacy')
  })

  it('полоса снизу и не перекрывает первый экран', () => {
    expect(banner).toMatch(/bottom:\s*0/)
    expect(banner).not.toMatch(/top:\s*0/)
  })
})
