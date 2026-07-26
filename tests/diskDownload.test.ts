import { describe, expect, it } from 'vitest'
import { downloadDiskFile, type BinaryFetchFn } from '../server/utils/diskDownload'
import type { RestCall } from '../server/utils/b24Rest'

const DOMAIN = 'portal.bitrix24.by'
const okUrl = `https://${DOMAIN}/download/abc?token=xyz`

/** Fake disk.file.get returning a fixed info object. */
function fakeCall(info: unknown): RestCall {
  return async (method) => {
    expect(method).toBe('disk.file.get')
    return info
  }
}

/** One-chunk async body. */
async function* oneChunk(b: Uint8Array): AsyncIterable<Uint8Array> {
  yield b
}
/** Multi-chunk async body (to exercise the streaming cap). */
async function* chunks(...cs: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const c of cs) yield c
}

/** Fake binary fetch streaming `body` for a 200; body null on non-200. */
function fakeFetch(body: AsyncIterable<Uint8Array> | null, status = 200): BinaryFetchFn {
  return async () => ({ ok: status === 200, status, body: status === 200 ? body : null })
}

describe('downloadDiskFile', () => {
  const bytes = new Uint8Array([1, 2, 3, 4])

  it('streams bytes to base64 (name from NAME)', async () => {
    const r = await downloadDiskFile(9, DOMAIN, fakeCall({ NAME: 'invoice.pdf', SIZE: 4, DOWNLOAD_URL: okUrl }), fakeFetch(oneChunk(bytes)))
    expect(r).toEqual({ name: 'invoice.pdf', base64: Buffer.from(bytes).toString('base64'), size: 4 })
  })

  it('reassembles multiple chunks', async () => {
    const r = await downloadDiskFile(9, DOMAIN, fakeCall({ DOWNLOAD_URL: okUrl }),
      fakeFetch(chunks(new Uint8Array([1, 2]), new Uint8Array([3, 4]))))
    expect(Buffer.from(r!.base64, 'base64')).toEqual(Buffer.from([1, 2, 3, 4]))
  })

  it('NAME missing → fallback name file-<id>', async () => {
    const r = await downloadDiskFile(42, DOMAIN, fakeCall({ SIZE: 4, DOWNLOAD_URL: okUrl }), fakeFetch(oneChunk(bytes)))
    expect(r?.name).toBe('file-42')
  })

  it('SSRF guard: DOWNLOAD_URL on a DIFFERENT host → null (never fetched)', async () => {
    const evil = fakeCall({ NAME: 'x', SIZE: 4, DOWNLOAD_URL: 'https://evil.example.com/steal' })
    let fetched = false
    const fetchFn: BinaryFetchFn = async () => {
      fetched = true
      return { ok: true, status: 200, body: oneChunk(bytes) }
    }
    expect(await downloadDiskFile(9, DOMAIN, evil, fetchFn)).toBeNull()
    expect(fetched).toBe(false)
  })

  it('streaming cap: body exceeding maxBytes → null (aborts, does not buffer)', async () => {
    // declared SIZE is small/absent but the stream is oversized — the POST-read streaming cap catches it.
    const big = fakeFetch(chunks(new Uint8Array(3), new Uint8Array(3))) // 6 bytes, cap 4
    expect(await downloadDiskFile(9, DOMAIN, fakeCall({ DOWNLOAD_URL: okUrl }), big, { maxBytes: 4 })).toBeNull()
  })

  it('declared SIZE over the cap → null before fetching', async () => {
    let fetched = false
    const fetchFn: BinaryFetchFn = async () => {
      fetched = true
      return { ok: true, status: 200, body: oneChunk(bytes) }
    }
    expect(await downloadDiskFile(9, DOMAIN, fakeCall({ DOWNLOAD_URL: okUrl, SIZE: 99 }), fetchFn, { maxBytes: 4 })).toBeNull()
    expect(fetched).toBe(false)
  })

  it('bad id / missing url / non-200 (redirect) / empty body → null', async () => {
    expect(await downloadDiskFile(0, DOMAIN, fakeCall({ DOWNLOAD_URL: okUrl }), fakeFetch(oneChunk(bytes)))).toBeNull()
    expect(await downloadDiskFile(9, DOMAIN, fakeCall({ NAME: 'x' }), fakeFetch(oneChunk(bytes)))).toBeNull() // no url
    expect(await downloadDiskFile(9, DOMAIN, fakeCall({ DOWNLOAD_URL: okUrl }), fakeFetch(null, 302))).toBeNull() // redirect:manual → 3xx
    expect(await downloadDiskFile(9, DOMAIN, fakeCall({ DOWNLOAD_URL: okUrl }), fakeFetch(chunks()))).toBeNull() // empty
  })

  it('empty portal domain → null', async () => {
    expect(await downloadDiskFile(9, '', fakeCall({ DOWNLOAD_URL: okUrl }), fakeFetch(oneChunk(bytes)))).toBeNull()
  })

  it('accepts a domain given with scheme/trailing slash', async () => {
    const r = await downloadDiskFile(9, 'https://portal.bitrix24.by/', fakeCall({ NAME: 'a', SIZE: 4, DOWNLOAD_URL: okUrl }), fakeFetch(oneChunk(bytes)))
    expect(r?.name).toBe('a')
  })
})
