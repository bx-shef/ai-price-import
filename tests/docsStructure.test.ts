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
