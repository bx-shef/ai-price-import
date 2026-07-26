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

/** Fake binary fetch returning bytes for a matching url. */
function fakeFetch(bytes: Uint8Array, status = 200): BinaryFetchFn {
  return async () => ({ ok: status === 200, status, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) })
}

describe('downloadDiskFile', () => {
  const bytes = new Uint8Array([1, 2, 3, 4])

  it('downloads bytes as base64 (name from NAME)', async () => {
    const r = await downloadDiskFile(9, DOMAIN, fakeCall({ NAME: 'invoice.pdf', SIZE: 4, DOWNLOAD_URL: okUrl }), fakeFetch(bytes))
    expect(r).toEqual({ name: 'invoice.pdf', base64: Buffer.from(bytes).toString('base64'), size: 4 })
  })

  it('SSRF guard: DOWNLOAD_URL on a DIFFERENT host → null (no fetch to a foreign host)', async () => {
    const evil = fakeCall({ NAME: 'x', SIZE: 4, DOWNLOAD_URL: 'https://evil.example.com/steal' })
    let fetched = false
    const fetchFn: BinaryFetchFn = async () => {
      fetched = true
      return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer }
    }
    expect(await downloadDiskFile(9, DOMAIN, evil, fetchFn)).toBeNull()
    expect(fetched).toBe(false)
  })

  it('bad id / missing url / non-200 / empty / oversize → null', async () => {
    expect(await downloadDiskFile(0, DOMAIN, fakeCall({ DOWNLOAD_URL: okUrl }), fakeFetch(bytes))).toBeNull()
    expect(await downloadDiskFile(9, DOMAIN, fakeCall({ NAME: 'x' }), fakeFetch(bytes))).toBeNull() // no url
    expect(await downloadDiskFile(9, DOMAIN, fakeCall({ DOWNLOAD_URL: okUrl }), fakeFetch(bytes, 404))).toBeNull()
    expect(await downloadDiskFile(9, DOMAIN, fakeCall({ DOWNLOAD_URL: okUrl }), fakeFetch(new Uint8Array(0)))).toBeNull()
    // declared SIZE over the cap → rejected before fetching
    expect(await downloadDiskFile(9, DOMAIN, fakeCall({ DOWNLOAD_URL: okUrl, SIZE: 99 }), fakeFetch(bytes), { maxBytes: 3 })).toBeNull()
  })

  it('empty portal domain → null', async () => {
    expect(await downloadDiskFile(9, '', fakeCall({ DOWNLOAD_URL: okUrl }), fakeFetch(bytes))).toBeNull()
  })

  it('accepts a domain given with scheme/trailing slash', async () => {
    const r = await downloadDiskFile(9, 'https://portal.bitrix24.by/', fakeCall({ NAME: 'a', SIZE: 4, DOWNLOAD_URL: okUrl }), fakeFetch(bytes))
    expect(r?.name).toBe('a')
  })
})
