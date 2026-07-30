import { describe, expect, it } from 'vitest'
import { FAILURE_CHAT_WINDOW_MS, claimErrorChatWindow, claimJobFailNotify, claimJobNotify, getUploaderId, createJob, getDiskFileId, getDiskFileUrl, getJob, getManualOverride, setDiskFile, setJobStatus, shouldWarnMissingArchive } from '../server/utils/jobStore'
import { createMemoryJobRedis } from '../server/utils/jobStoreRedis'

// The store logic is exercised over the in-memory JobRedis (same interface as the live ioredis
// adapter) — no infra, deterministic. A controllable clock drives TTL expiry.

describe('jobStore (Redis-backed)', () => {
  it('createJob → getJob round-trips status/fileName; result starts empty', async () => {
    const r = createMemoryJobRedis()
    await createJob('m', 'j1', 'накладная.pdf', r)
    expect(await getJob('m', 'j1', r)).toEqual({ memberId: 'm', jobId: 'j1', status: 'queued', fileName: 'накладная.pdf', result: '' })
  })

  it('getJob is member+job scoped (no cross-portal read)', async () => {
    const r = createMemoryJobRedis()
    await createJob('m1', 'j1', 'f.pdf', r)
    expect(await getJob('m2', 'j1', r)).toBeNull()
    expect(await getJob('m1', 'jX', r)).toBeNull()
  })

  it('setJobStatus updates status + result without dropping fileName', async () => {
    const r = createMemoryJobRedis()
    await createJob('m', 'j1', 'f.pdf', r)
    await setJobStatus('m', 'j1', 'done', JSON.stringify({ created: true }), r)
    const j = await getJob('m', 'j1', r)
    expect(j?.status).toBe('done')
    expect(j?.result).toBe('{"created":true}')
    expect(j?.fileName).toBe('f.pdf')
  })

  it('manual override round-trips + re-validates (junk → undefined)', async () => {
    const r = createMemoryJobRedis()
    await createJob('m', 'j1', 'f.pdf', r, { entityTypeId: 2, categoryId: 1 })
    expect(await getManualOverride('m', 'j1', r)).toEqual({ entityTypeId: 2, categoryId: 1 })
    await createJob('m', 'j2', 'f.pdf', r) // no override
    expect(await getManualOverride('m', 'j2', r)).toBeUndefined()
  })

  it('disk file: setDiskFile then getDiskFileUrl normalizes an absolute DETAIL_URL to a relative path', async () => {
    const r = createMemoryJobRedis()
    await createJob('m', 'j1', 'f.pdf', r)
    await setDiskFile('m', 'j1', { id: 5, detailUrl: 'https://bel.bitrix24.by/docs/file/5/' }, r)
    expect(await getDiskFileUrl('m', 'j1', r)).toBe('/docs/file/5/')
    // getJob surfaces the same relative path as `diskUrl` (for the UI file-name link).
    expect((await getJob('m', 'j1', r))?.diskUrl).toBe('/docs/file/5/')
    // absent → null / no diskUrl key
    await createJob('m', 'j2', 'f.pdf', r)
    expect(await getDiskFileUrl('m', 'j2', r)).toBeNull()
    expect((await getJob('m', 'j2', r))?.diskUrl).toBeUndefined()
  })

  it('getDiskFileId: returns the stored id, null when absent/invalid', async () => {
    const r = createMemoryJobRedis()
    await createJob('m', 'j1', 'f.pdf', r)
    await setDiskFile('m', 'j1', { id: 7, detailUrl: 'https://x/docs/file/7/' }, r)
    expect(await getDiskFileId('m', 'j1', r)).toBe(7)
    // no diskFile → null
    await createJob('m', 'j2', 'f.pdf', r)
    expect(await getDiskFileId('m', 'j2', r)).toBeNull()
    // unknown member/job → null
    expect(await getDiskFileId('m', 'nope', r)).toBeNull()
  })

  it('claimJobNotify is once-only: first caller true, all later false', async () => {
    const r = createMemoryJobRedis()
    await createJob('m', 'j1', 'f.pdf', r)
    expect(await claimJobNotify('m', 'j1', r)).toBe(true)
    expect(await claimJobNotify('m', 'j1', r)).toBe(false)
    expect(await claimJobNotify('m', 'j1', r)).toBe(false)
  })

  it('getJob returns null once the job hash expires past its TTL (nothing accumulates)', async () => {
    let t = 0
    const r = createMemoryJobRedis(() => t)
    await createJob('m', 'j1', 'a.pdf', r)
    expect(await getJob('m', 'j1', r)).not.toBeNull()
    t += 49 * 60 * 60 * 1000 // past the 48h default TTL
    expect(await getJob('m', 'j1', r)).toBeNull()
  })
})

// #263: пропажа кнопки «Исходный файл» была полностью немой — ни в журнале, ни где-либо ещё.
describe('shouldWarnMissingArchive', () => {
  it('архивация включена, ссылки нет — предупреждаем', () => {
    expect(shouldWarnMissingArchive(true, null)).toBe(true)
    expect(shouldWarnMissingArchive(true, undefined)).toBe(true)
    expect(shouldWarnMissingArchive(true, '')).toBe(true)
  })
  it('архивация выключена — терять нечего, молчим', () => {
    expect(shouldWarnMissingArchive(false, null)).toBe(false)
  })
  it('ссылка есть — молчим', () => {
    expect(shouldWarnMissingArchive(true, '/docs/file/x')).toBe(false)
  })
})

// Кому писать об отказе — записывается при загрузке из проверенного фрейм-токена.
describe('getUploaderId', () => {
  it('возвращает записанного сотрудника', async () => {
    const r = createMemoryJobRedis()
    await createJob('m', 'j', 'файл.pdf', r, null, '42')
    expect(await getUploaderId('m', 'j', r)).toBe('42')
  })
  it('не записан — null, писать некому', async () => {
    const r = createMemoryJobRedis()
    await createJob('m', 'j', 'файл.pdf', r)
    expect(await getUploaderId('m', 'j', r)).toBeNull()
  })
  it('мусор вместо идентификатора не превращается в адрес чата', async () => {
    const r = createMemoryJobRedis()
    // Значение уходит в DIALOG_ID: пропускаем только положительное целое.
    for (const bad of ['0', '-5', 'chat7', '1 OR 1', '']) {
      await createJob('m', 'j', 'f', r, null, bad)
      expect(await getUploaderId('m', 'j', r)).toBeNull()
    }
  })
  it('once-only заявка на уведомление о провале: второй раз false', async () => {
    const r = createMemoryJobRedis()
    await createJob('m', 'j', 'f', r)
    expect(await claimJobFailNotify('m', 'j', r)).toBe(true)
    expect(await claimJobFailNotify('m', 'j', r)).toBe(false)
  })
  it('заявки успеха и провала независимы — это разные события', async () => {
    const r = createMemoryJobRedis()
    await createJob('m', 'j', 'f', r)
    expect(await claimJobNotify('m', 'j', r)).toBe(true)
    expect(await claimJobFailNotify('m', 'j', r)).toBe(true)
  })
})

// Тихий период чата ошибок: отказы приходят пачкой (нет валюты в портале — падают все документы),
// и без этого администратор получал по сообщению на каждый.
describe('claimErrorChatWindow', () => {
  it('первый раз в окне — можно, второй — нет', async () => {
    const r = createMemoryJobRedis()
    expect(await claimErrorChatWindow('m', 1_000_000, r)).toBe(true)
    expect(await claimErrorChatWindow('m', 1_000_000, r)).toBe(false)
  })
  it('следующее окно открывается заново', async () => {
    const r = createMemoryJobRedis()
    expect(await claimErrorChatWindow('m', 0, r)).toBe(true)
    expect(await claimErrorChatWindow('m', FAILURE_CHAT_WINDOW_MS, r)).toBe(true)
  })
  it('тишина у одного портала не глушит другой', async () => {
    const r = createMemoryJobRedis()
    expect(await claimErrorChatWindow('A', 0, r)).toBe(true)
    expect(await claimErrorChatWindow('B', 0, r)).toBe(true)
  })
})
