import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

// Guard against committing local dev artefacts. This already happened once: `pnpm loadtest:queue`
// asks for a local Redis, and a Redis started from the repo root drops its dump.rdb right here —
// which then got picked up by `git add -A`. .gitignore now covers it, but .gitignore only helps
// people who have the current one; a forced add or a stale checkout still slips through.
//
// If this test fails: `git rm --cached <file>`, and make sure the pattern is in .gitignore.
// Do not delete the test — it is the thing that made the mistake visible.

const trackedFiles = (): string[] =>
  execFileSync('git', ['ls-files'], { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname })
    .split('\n')
    .filter(Boolean)

describe('в индексе нет артефактов локального прогона', () => {
  it('нет дампов Redis (*.rdb, *.aof)', () => {
    expect(trackedFiles().filter(f => /\.(rdb|aof)$/i.test(f))).toEqual([])
  })

  it('нет логов и локальных env-файлов (кроме .env.example)', () => {
    const bad = trackedFiles().filter(f =>
      /\.log$/i.test(f) || (/(^|\/)\.env/.test(f) && !f.endsWith('.example')))
    expect(bad).toEqual([])
  })
})
