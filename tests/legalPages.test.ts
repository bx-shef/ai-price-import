import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LEGAL_ARCHIVE } from '../app/config/legalArchive'

// The legal pages RENDER `docs/*.md` through a `?raw` import instead of carrying a second copy of
// the text (#297, вариант В). That makes those files BUILD INPUTS — and `.dockerignore` excludes
// `docs` wholesale, so the app built fine locally while the backend image failed at `pnpm build`
// with a bare ENOENT. Nothing in the test suite could see it: Vitest reads the repo, not the
// Docker context.
//
// The invariant is stated over the PAGES, not over a hand-written list: a third legal page added
// tomorrow gets the same guard for free, which is the whole failure mode here.
const ROOT = new URL('../', import.meta.url).pathname

/**
 * Every `docs/<file>.md?raw` import anywhere in the app or the server.
 *
 * Замечание ревью: первая редакция читала ОДИН каталог (`app/pages`, без вложенности) и требовала
 * буквального написания `'~~/docs/x.md?raw'`. Страница в подкаталоге, тот же импорт из компонента
 * или относительный путь воспроизводят ровно ту же аварию сборки образа — то есть инвариант был
 * заявлен над страницами, а проверялся над одним каталогом и одним написанием.
 *
 * Поэтому: рекурсивный обход `app/` и `server/`, и путь берётся из ХВОСТА совпадения, каким бы
 * алиасом он ни был записан.
 */
const ROOTS = ['app', 'server']

function rawDocImports(): string[] {
  const found = new Set<string>()
  for (const root of ROOTS) {
    for (const name of readdirSync(join(ROOT, root), { recursive: true }) as string[]) {
      if (!/\.(vue|ts|mts|js)$/.test(name)) continue
      const full = join(ROOT, root, name)
      if (statSync(full).isDirectory()) continue
      for (const m of readFileSync(full, 'utf8').matchAll(/(docs\/[\w.-]+\.md)\?raw/g)) found.add(m[1]!)
    }
  }
  return [...found].sort()
}

describe('юридические страницы рендерят файл из docs/ (#297)', () => {
  it('каждый импортированный документ возвращён в docker-контекст', () => {
    const sources = rawDocImports()
    // Sanity: если импорты исчезли, тест обязан покраснеть, а не «пройти» на пустом множестве.
    expect(sources.length, 'страницы больше не импортируют документы — гард потерял смысл').toBeGreaterThan(0)

    const ignore = readFileSync(join(ROOT, '.dockerignore'), 'utf8')
      .split('\n')
      .map(l => l.trim())
    const missing = sources.filter(s => !ignore.includes(`!${s}`))
    expect(missing, `добавьте «!<путь>» в .dockerignore, иначе сборка образа упадёт ENOENT:\n${missing.join('\n')}`).toEqual([])
  })

  it('снимки редакций возвращены в docker-контекст', () => {
    // ⚠ Отдельная проверка, потому что снимки приходят НЕ через `docs/x.md?raw`, а через
    // `import.meta.glob('~~/docs/archive/**/*.md')` — регулярка выше их не видит по построению.
    // Цена промаха выяснена на живой сборке: в образе `docs/archive` не было, глоб находил ноль
    // файлов, и все четыре постоянных адреса падали в 404 прямо на пререндере.
    const ignore = readFileSync(join(ROOT, '.dockerignore'), 'utf8').split('\n').map(l => l.trim())
    expect(ignore, 'папка снимков не возвращена в контекст').toContain('!docs/archive')
    expect(ignore, 'содержимое папки снимков не возвращено в контекст').toContain('!docs/archive/**')
    // И сами файлы на месте — пустой глоб дал бы тот же 404, но уже по другой причине.
    for (const doc of LEGAL_ARCHIVE) {
      for (const e of doc.editions) {
        expect(readFileSync(join(ROOT, `docs/archive/${doc.slug}/${e.date}.md`), 'utf8').length).toBeGreaterThan(100)
      }
    }
  })

  it('сами документы существуют — иначе страница соберётся пустой', () => {
    for (const s of rawDocImports()) {
      expect(readFileSync(join(ROOT, s), 'utf8').length, `${s} пуст`).toBeGreaterThan(100)
    }
  })
})
