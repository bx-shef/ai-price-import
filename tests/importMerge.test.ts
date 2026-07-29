import { describe, expect, it } from 'vitest'
import { EXPIRED_RESULT, SERVER_STATUS_TTL_MS, mergeJobRows, type LocalJobRow, type ServerJobRow } from '../app/utils/importMerge'

const NOW = 10_000_000_000
const PORTAL = 'my.bitrix24.by'
const srv = (jobId: string, over: Partial<ServerJobRow> = {}): ServerJobRow =>
  ({ jobId, status: 'done', fileName: 'srv.pdf', result: '{}', ...over })
const loc = (jobId: string, over: Partial<LocalJobRow> = {}): LocalJobRow =>
  ({ jobId, fileName: `${jobId}.pdf`, at: NOW, portal: PORTAL, ...over })
const merge = (local: LocalJobRow[], server: ServerJobRow[]) =>
  mergeJobRows(local, server, { portal: PORTAL, now: NOW })

describe('mergeJobRows', () => {
  it('берёт статус с сервера, а имя файла — из локальной истории', () => {
    expect(merge([loc('a', { fileName: 'накладная.pdf' })], [srv('a', { status: 'processing' })]))
      .toEqual([{ jobId: 'a', status: 'processing', fileName: 'накладная.pdf', result: '{}' }])
  })

  it('старая строка своего портала не пропадает — становится «expired» с объяснением (#268)', () => {
    const old = loc('old', { fileName: 'счёт.xlsx', at: NOW - SERVER_STATUS_TTL_MS })
    expect(merge([old], []))
      .toEqual([{ jobId: 'old', status: 'expired', fileName: 'счёт.xlsx', result: EXPIRED_RESULT }])
  })

  it('свежая строка без серверного статуса просто скрывается — назвать её «истёкшей» было бы ложью', () => {
    // Так выглядит загрузка, которая до сервера не доехала: запись в браузере есть с первой миллисекунды.
    expect(merge([loc('fresh', { at: NOW - 60_000 })], [])).toEqual([])
  })

  it('строка ЧУЖОГО портала не показывается: localStorage общий на домен приложения, а не на портал', () => {
    const foreign = loc('x', { portal: 'other.bitrix24.ru', at: NOW - SERVER_STATUS_TTL_MS })
    expect(merge([foreign], [])).toEqual([])
  })

  it('строка без отметки о портале (записана до появления поля) тоже не показывается', () => {
    const legacy: LocalJobRow = { jobId: 'legacy', fileName: 'l.pdf', at: NOW - SERVER_STATUS_TTL_MS }
    expect(merge([legacy], [])).toEqual([])
  })

  it('сохраняет порядок локальной истории и не добавляет чужие серверные строки', () => {
    const rows = merge([loc('b'), loc('a')], [srv('a'), srv('z'), srv('b')])
    expect(rows.map(r => r.jobId)).toEqual(['b', 'a'])
  })

  it('пустое локальное имя заменяется серверным; diskUrl пробрасывается только когда он есть', () => {
    const [withUrl, withoutUrl] = merge(
      [loc('a', { fileName: '' }), loc('b')],
      [srv('a', { diskUrl: '/docs/file/5/' }), srv('b')]
    )
    expect(withUrl).toMatchObject({ fileName: 'srv.pdf', diskUrl: '/docs/file/5/' })
    expect(withoutUrl).not.toHaveProperty('diskUrl')
  })
})
