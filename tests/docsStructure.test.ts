import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Guards for the documentation set. All three came out of a real cleanup (2026-07-29): docs/ had
// grown to 40 files across two folders, half of them describing an architecture that no longer
// existed, with dead cross-links nobody noticed. These tests keep that from creeping back.

const ROOT = new URL('..', import.meta.url).pathname
const abs = (p: string) => resolve(ROOT, p)

/**
 * Files allowed in docs/. Three project documents + five hand-off materials for third parties.
 *
 * The list is a whitelist, not a cap: a new file needs a decision, not just a `git add`. `PRICING.md`
 * was added by an explicit owner decision (#301) — it is a commercial document (revenue model, rates,
 * packages), addressed outward like `ui-spec.md` and `privacy-policy.md`, and merging it into any of
 * the three project documents would put price negotiation into engineering notes. `eula.md` was added the same way (#297): the
 * Market requires a licence agreement at a permanent public address, the project had none, and it is
 * the SOURCE the `/eula` page renders — merging it into another document would break that page.
 * `market-graphics.md` is the third such decision (owner, 2026-08-03, #387): the Market listing
 * artwork is commissioned from an outside designer, so the brief leaves the project the way
 * `ui-spec.md` does — and it is deliberately NOT part of `ui-spec.md`, whose scope note now names
 * the listing as a separate job (that note was extended in the same change; before it, only the
 * public site was excluded, so this justification pointed at a line that did not exist).
 */
const ALLOWED_DOCS = [
  'PROCESS.md', // как работает продукт
  'PROJECT_MAP.md', // что в каком состоянии
  'BACKLOG.md', // что делаем потом
  'ui-spec.md', // дизайнеру
  'privacy-policy.md', // юристу и на публикацию
  'PRICING.md', // модель заработка + калькулятор кастомной работы (#301)
  'eula.md', // лицензионное соглашение — публикуется на лендинге (#297, решение владельца)
  'market-graphics.md', // тексты для графики карточки Маркета — дизайнеру (#387, решение владельца)
  // Справка для службы ИБ клиента (#420, решение владельца 2026-08-06). Четвёртый файл «наружу»:
  // корпоративный клиент присылает опросник до установки, и отвечать на него ссылками «пункт 6.4
  // Политики, пункт 8.3 Политики» — значит заставлять чужого безопасника читать юридический текст
  // целиком. Отдельный файл, а не раздел `PROCESS.md`: тот описывает, КАК работает продукт, для нас,
  // и уходит клиенту вместе с внутренними заметками. ⚠ Справка НИЧЕГО не объявляет сама — каждый
  // ответ ссылается на пункт Политики или Лицензии, и она прямо говорит, что при расхождении
  // действует документ. Иначе появился бы пятый источник обязательств, который никто не сверяет.
  'it-security.md',
  // Пакет юриста 2026-08-08 (#297): у САЙТА своя пара документов, отдельная от документов
  // ПРИЛОЖЕНИЯ. Сайт и приложение — разные продукты с разными аудиториями: посетитель демо не
  // устанавливал приложение и лицензией не связан. Обе страницы публикуются по постоянным адресам
  // и рендерятся из этих файлов, поэтому слить их с `eula.md`/`privacy-policy.md` нельзя.
  'site-terms.md',
  'site-privacy.md',
  // Обоснования правок для юриста — НЕ публикуются. Лежат в `docs/internal/`, чтобы не попасть ни в
  // публичную выдачу, ни в docker-контекст страниц.
  'internal',
  // Снимки редакций (#415). Плоскую структуру ломает осознанно: архиву нужны ПРОШЛЫЕ тексты, а в
  // `docs/` лежит только действующий. Хранить их файлами честнее, чем собирать из git: репозиторий
  // закрыт и доказательством не является, а закоммиченный и опубликованный файл — является.
  'archive'
]

const docsFiles = () => readdirSync(abs('docs'))
const markdownSet = () => ['README.md', 'CLAUDE.md', ...docsFiles().filter(f => f.endsWith('.md')).map(f => `docs/${f}`)]

describe('структура документации', () => {
  it('в docs/ только разрешённые файлы — новые .md не заводим, дописываем в существующие', () => {
    expect([...docsFiles()].sort()).toEqual([...ALLOWED_DOCS].sort())
  })

  it('в docs/ ровно две вложенные папки — internal (не публикуется) и archive (снимки редакций)', () => {
    // Плоскую структуру держим ради того же, ради чего заведён белый список. Исключение ровно одно:
    // записки для юриста не должны лежать рядом с публикуемыми документами, иначе их однажды
    // отрендерит страница или подхватит выдача.
    const dirs = docsFiles().filter(f => statSync(abs(`docs/${f}`)).isDirectory()).sort()
    expect(dirs).toEqual(['archive', 'internal'])
  })
})

/**
 * Публикуемые юридические документы штамп НЕ несут (пакет юриста 2026-08-08, #297).
 *
 * Штамп — внутренняя пометка о свежести текста, а эти четыре файла целиком уходят наружу: их
 * рендерят публичные страницы, и «Last reviewed» встал бы в опубликованный документ рядом с
 * «Редакция от» и «Дата вступления в силу». Две даты о разном в юридическом тексте читаются как
 * противоречие, а свежесть тут задаёт сам документ — редакцией и датой вступления в силу.
 */
const PUBLISHED_LEGAL = ['docs/eula.md', 'docs/privacy-policy.md', 'docs/site-terms.md', 'docs/site-privacy.md']

describe('штамп ревью', () => {
  for (const file of markdownSet().filter(f => !PUBLISHED_LEGAL.includes(f))) {
    it(`${file}: несёт «> Last reviewed: ГГГГ-ММ-ДД»`, () => {
      expect(readFileSync(abs(file), 'utf8')).toMatch(/^> Last reviewed: \d{4}-\d{2}-\d{2}$/m)
    })
  }
})

describe('юридические документы датированы по-своему', () => {
  // Обратная половина исключения выше: сняв штамп, легко получить документ вообще без даты — и
  // тогда «какая редакция опубликована» станет неотвечаемым вопросом ровно там, где он важнее
  // всего. Дата редакции и дата вступления в силу обязаны стоять в самом тексте.
  for (const file of PUBLISHED_LEGAL) {
    it(`${file}: несёт редакцию и дату вступления в силу`, () => {
      const text = readFileSync(abs(file), 'utf8')
      expect(text).toMatch(/\*\*Редакция от:\*\* \d{2}\.\d{2}\.\d{4}/)
      expect(text).toMatch(/\*\*Дата вступления редакции в силу:\*\* \d{2}\.\d{2}\.\d{4}/)
    })
  }

  it('все четыре документа объявляют ОДНУ редакцию и одну дату вступления', () => {
    // Пара документов сайта и пара документов приложения ссылаются друг на друга; разъехавшиеся
    // даты означают, что человек читает две редакции сразу и не знает, какая действует.
    const stamps = PUBLISHED_LEGAL.map((f) => {
      const t = readFileSync(abs(f), 'utf8')
      return `${t.match(/\*\*Редакция от:\*\* (\d{2}\.\d{2}\.\d{4})/)?.[1]} → ${t.match(/\*\*Дата вступления редакции в силу:\*\* (\d{2}\.\d{2}\.\d{4})/)?.[1]}`
    })
    expect(new Set(stamps).size, `даты разъехались: ${stamps.join(' | ')}`).toBe(1)
  })
})

/**
 * Справка для службы ИБ (#420) — производная от Политики и Лицензии: у КАЖДОГО её ответа стоит
 * номер пункта первоисточника, и это единственное, чем она ценна.
 *
 * ⚠ Гард заведён потому, что дефект здесь тихий и уже случался в проекте: юрист меняет нумерацию
 * (так уехали пп. 2.3/5.4, на которые ссылалась заметка в `market-graphics.md`), справка остаётся
 * со старыми номерами — и внешний безопасник получает отсылку в пустоту из документа, который сам
 * же называет источником истины. Проверить смысл автоматом нельзя, а существование пункта — можно,
 * и этого достаточно: перенумерация ловится, а переписанный пункт с тем же номером вскроется при
 * ближайшем чтении.
 *
 * ⚠ Поэтому же в самой справке КАЖДАЯ ссылка обязана называть документ («п. 8.1 Политики»):
 * голый номер существует в обоих файлах почти всегда, и проверка «есть хоть где-нибудь» была бы
 * декоративной.
 */
describe('справка для ИБ ссылается на существующие пункты', () => {
  const SOURCES: Record<string, string> = { Политики: 'docs/privacy-policy.md', Лицензии: 'docs/eula.md' }
  const text = readFileSync(abs('docs/it-security.md'), 'utf8')
  // `п. 8.4–8.5 Политики` — проверяем ОБА конца диапазона, иначе правый молча не сверяется.
  const refs = [...text.matchAll(/п\. (\d+\.\d+)(?:[–-](\d+\.\d+))? (Политики|Лицензии)/g)]
    .flatMap(m => [{ n: m[1]!, doc: m[3]! }, ...(m[2] ? [{ n: m[2], doc: m[3]! }] : [])])

  it('ссылок вообще много — иначе проверка ниже пуста и зелена', () => {
    // Разбор поймал бы это первым: регулярка, переставшая совпадать (сменили формат ссылок), делает
    // весь блок ниже нулевым, и он остаётся зелёным ровно тогда, когда перестал работать.
    expect(refs.length).toBeGreaterThan(25)
  })

  for (const { n, doc } of refs) {
    it(`п. ${n} ${doc} существует`, () => {
      const src = readFileSync(abs(SOURCES[doc]!), 'utf8')
      expect(src, `${SOURCES[doc]} не содержит пункта ${n}`).toMatch(new RegExp(`^${n.replace('.', '\\.')}\\. `, 'm'))
    })
  }
})

describe('внутренние ссылки не битые', () => {
  for (const file of markdownSet()) {
    it(`${file}: все ссылки на .md ведут в существующий файл`, () => {
      const text = readFileSync(abs(file), 'utf8')
      const from = dirname(abs(file))
      const broken = [...text.matchAll(/\]\((?!https?:)([^)#\s]+\.md)(?:#[^)]*)?\)/g)]
        .map(m => m[1]!)
        .filter(rel => !existsSync(resolve(from, rel)))
      expect(broken, `битые ссылки: ${broken.join(', ')}`).toEqual([])
    })
  }
})

// Три проверки ниже добавлены после разбора документации (2026-07-30): каждая ловит дефект, который
// реально дожил до main незамеченным, потому что прежние гварды смотрели в другую сторону.

/**
 * Мелкий клон (`git clone --depth 1`, как делает `actions/checkout` по умолчанию) историю не несёт:
 * там ровно один коммит, и `git log` по ЛЮБОМУ файлу вернёт его — то есть «файл изменён сегодня».
 * Проверять свежесть штампа в таких условиях бессмысленно: тест падал бы на каждом PR, где доки не
 * переставлены на сегодняшнюю дату, и ловил бы не дрейф, а факт выкачки репозитория.
 */
function historyAvailable(): boolean {
  try {
    return execFileSync('git', ['rev-parse', '--is-shallow-repository'],
      { cwd: ROOT, encoding: 'utf8' }).trim() === 'false'
  } catch {
    return false // не git-checkout вовсе (архив, tarball)
  }
}

describe('штамп ревью не отстаёт от правок', () => {
  for (const file of markdownSet().filter(f => !PUBLISHED_LEGAL.includes(f))) {
    it(`${file}: дата в штампе не старше последнего коммита файла`, () => {
      if (!historyAvailable()) return
      const text = readFileSync(abs(file), 'utf8')
      const stamp = text.match(/^> Last reviewed: (\d{4}-\d{2}-\d{2})$/m)?.[1]
      // Дата последнего коммита, тронувшего файл. `short-local` + TZ=UTC — чтобы вердикт не зависел
      // от часового пояса машины: иначе вечерний коммит читался бы как «завтрашний» в UTC-раннере.
      let committed: string
      try {
        committed = execFileSync('git', ['log', '-1', '--format=%ad', '--date=short-local', '--', file],
          { cwd: ROOT, encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } }).trim()
      } catch {
        return
      }
      if (!committed) return // файл ещё не коммитили
      expect(stamp, `${file}: нет штампа`).toBeTruthy()
      // Правишь документ — бампни дату. Иначе «Last reviewed» превращается в дату создания и
      // перестаёт отвечать на вопрос, ради которого заведён: насколько тексту можно верить.
      expect(stamp! >= committed, `${file}: штамп ${stamp} старше последней правки ${committed}`).toBe(true)
    })
  }
})

describe('ссылки на документацию из конфигов', () => {
  // Ссылки на доки живут не только в markdown: их полно в .env.example, nginx.conf и compose-файлах,
  // и при сворачивании 40 файлов в пять там осталась россыпь ссылок на удалённое — гвард их не видел.
  const CONFIGS = ['.env.example', 'nginx.conf', 'docker-compose.yml', 'docker-compose.prod.yml']
  for (const file of CONFIGS) {
    it(`${file}: упомянутые файлы документации существуют`, () => {
      if (!existsSync(abs(file))) return
      const text = readFileSync(abs(file), 'utf8')
      const broken = [...text.matchAll(/docs\/[\w/-]+\.md/g)]
        .map(m => m[0]!)
        .filter(rel => !existsSync(abs(rel)))
      expect([...new Set(broken)], `ссылки на удалённые документы: ${broken.join(', ')}`).toEqual([])
    })
  }
})

describe('живые проверки перечислены в документации', () => {
  // Скрипт, о котором никто не знает, не будет запущен. verify:332 полгода жил вне документации.
  it('каждая команда pnpm verify:*/loadtest:* названа в PROJECT_MAP или CLAUDE.md', () => {
    const pkg = JSON.parse(readFileSync(abs('package.json'), 'utf8')) as { scripts: Record<string, string> }
    const live = Object.keys(pkg.scripts).filter(n => /^(verify|loadtest|sdk):/.test(n))
    const docs = readFileSync(abs('docs/PROJECT_MAP.md'), 'utf8') + readFileSync(abs('CLAUDE.md'), 'utf8')
    const missing = live.filter(n => !docs.includes(`pnpm ${n}`))
    expect(missing, `не описаны: ${missing.join(', ')}`).toEqual([])
  })
})
