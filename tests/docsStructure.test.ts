import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Guards for the documentation set. All three came out of a real cleanup (2026-07-29): docs/ had
// grown to 40 files across two folders, half of them describing an architecture that no longer
// existed, with dead cross-links nobody noticed. These tests keep that from creeping back.

const ROOT = new URL('..', import.meta.url).pathname
const abs = (p: string) => resolve(ROOT, p)

/** Files allowed in docs/. Three project documents + two hand-off materials for third parties. */
const ALLOWED_DOCS = [
  'PROCESS.md', // как работает продукт
  'PROJECT_MAP.md', // что в каком состоянии
  'BACKLOG.md', // что делаем потом
  'ui-spec.md', // дизайнеру
  'privacy-policy.md' // юристу и на публикацию
]

const docsFiles = () => readdirSync(abs('docs'))
const markdownSet = () => ['README.md', 'CLAUDE.md', ...docsFiles().filter(f => f.endsWith('.md')).map(f => `docs/${f}`)]

describe('структура документации', () => {
  it('в docs/ только разрешённые файлы — новые .md не заводим, дописываем в существующие', () => {
    expect([...docsFiles()].sort()).toEqual([...ALLOWED_DOCS].sort())
  })

  it('в docs/ нет вложенных папок — плоская структура', () => {
    const dirs = docsFiles().filter(f => statSync(abs(`docs/${f}`)).isDirectory())
    expect(dirs).toEqual([])
  })
})

describe('штамп ревью', () => {
  for (const file of markdownSet()) {
    it(`${file}: несёт «> Last reviewed: ГГГГ-ММ-ДД»`, () => {
      expect(readFileSync(abs(file), 'utf8')).toMatch(/^> Last reviewed: \d{4}-\d{2}-\d{2}$/m)
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

describe('штамп ревью не отстаёт от правок', () => {
  for (const file of markdownSet()) {
    it(`${file}: дата в штампе не старше последнего коммита файла`, () => {
      const text = readFileSync(abs(file), 'utf8')
      const stamp = text.match(/^> Last reviewed: (\d{4}-\d{2}-\d{2})$/m)?.[1]
      // Дата последнего коммита, тронувшего файл. Вне git-checkout (архив, tarball) — пропускаем.
      let committed: string
      try {
        committed = execFileSync('git', ['log', '-1', '--format=%ad', '--date=short', '--', file],
          { cwd: ROOT, encoding: 'utf8' }).trim()
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
