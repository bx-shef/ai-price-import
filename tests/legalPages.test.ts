import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The legal pages RENDER `docs/*.md` through a `?raw` import instead of carrying a second copy of
// the text (#297, вариант В). That makes those files BUILD INPUTS — and `.dockerignore` excludes
// `docs` wholesale, so the app built fine locally while the backend image failed at `pnpm build`
// with a bare ENOENT. Nothing in the test suite could see it: Vitest reads the repo, not the
// Docker context.
//
// The invariant is stated over the PAGES, not over a hand-written list: a third legal page added
// tomorrow gets the same guard for free, which is the whole failure mode here.
const ROOT = new URL('../', import.meta.url).pathname
const PAGES_DIR = join(ROOT, 'app/pages')

/** `~~/docs/<file>.md?raw` → `docs/<file>.md`, over every page. */
function rawDocImports(): string[] {
  const found = new Set<string>()
  for (const name of readdirSync(PAGES_DIR)) {
    if (!name.endsWith('.vue')) continue
    const text = readFileSync(join(PAGES_DIR, name), 'utf8')
    for (const m of text.matchAll(/['"]~~\/(docs\/[\w.-]+\.md)\?raw['"]/g)) found.add(m[1]!)
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

  it('сами документы существуют — иначе страница соберётся пустой', () => {
    for (const s of rawDocImports()) {
      expect(readFileSync(join(ROOT, s), 'utf8').length, `${s} пуст`).toBeGreaterThan(100)
    }
  })
})
