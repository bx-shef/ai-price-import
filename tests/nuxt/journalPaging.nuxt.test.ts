// @vitest-environment nuxt
import { describe, expect, it, afterEach } from 'vitest'
import { mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime'
import { getQuery } from 'h3'
import { useImportJournal } from '~/composables/useImportJournal'
import { JOURNAL_PAGE_SIZE } from '~/config/journal'

// #495. Постраничная навигация: страница адресуется НОМЕРОМ. Разбор мутациями показал, что подмена
// «номер страницы» → «длина показанного списка» проходила бесследно, а это настоящий дефект: при
// постраничном показе список каждый раз ЗАМЕЩАЕТСЯ, поэтому его длина на второй странице снова
// равна размеру страницы — «Дальше» возвращало бы человека на те же самые записи.
//
// ⚠ Проверяется то, что РЕАЛЬНО уходит порталу, а не то, что видно на экране: смещение — это
// параметр запроса, и увидеть его подмену можно только здесь.

mockNuxtImport('useB24', () => () => ({
  auth: () => ({ accessToken: 't', domain: 'p.bitrix24.by' }),
  inFrame: () => true
}))

const seen: unknown[] = []
registerEndpoint('/api/import/journal', (event) => {
  seen.push(getQuery(event).start)
  return { rows: [], hasMore: true }
})

afterEach(() => {
  seen.length = 0
})

describe('#495: смещение страницы считается по НОМЕРУ, а не по длине списка', () => {
  it('первая страница просит нулевое смещение', async () => {
    const j = useImportJournal()
    await j.load()
    expect(Number(seen.at(-1))).toBe(0)
  })

  it('вторая и третья — кратно размеру страницы', async () => {
    const j = useImportJournal()
    await j.goto(1)
    expect(Number(seen.at(-1))).toBe(JOURNAL_PAGE_SIZE)
    await j.goto(2)
    expect(Number(seen.at(-1))).toBe(JOURNAL_PAGE_SIZE * 2)
  })

  it('назад с первой страницы невозможно — отрицательного смещения не бывает', async () => {
    const j = useImportJournal()
    await j.goto(-3)
    expect(Number(seen.at(-1))).toBe(0)
  })
})
