import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Nitro routes by FILE NAME, so «этот роут только POST» — структурный факт, а не поведение функции:
// проверить его можно только по раскладке файлов и по вызову на клиенте. Тест сторожит откат #260
// (список id обратно в адресную строку), который иначе прошёл бы CI незамеченным.
const ROOT = new URL('..', import.meta.url).pathname
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8')

describe('опрос статусов — только POST (#260)', () => {
  it('роут лежит как status.post.ts, GET-варианта нет', () => {
    expect(existsSync(resolve(ROOT, 'server/api/import/status.post.ts'))).toBe(true)
    expect(existsSync(resolve(ROOT, 'server/api/import/status.get.ts'))).toBe(false)
  })

  it('клиент шлёт POST с телом, а не query со списком id', () => {
    const src = read('app/composables/useImport.ts')
    const call = src.slice(src.indexOf('/api/import/status'), src.indexOf('/api/import/status') + 300)
    expect(call).toContain('method: \'POST\'')
    expect(call).toContain('body: { ids }')
    expect(src).not.toContain('query: { ids')
  })

  it('роут ограничивает размер тела — единственный, читающий JSON без предела', () => {
    expect(read('server/api/import/status.post.ts')).toContain('bodySizeStatus')
  })
})
