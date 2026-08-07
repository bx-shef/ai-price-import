import { describe, expect, it, vi } from 'vitest'
import { handleCrmSyncJob, handleEventJob } from '../server/queue/handlers'
import { eventJobToSaveInput, type EventJob } from '../server/queue/topology'
import { defaultMapping } from '../app/utils/portalSettings'
import type { ExtractedDocument } from '../app/types/document'
import { parseJobResult } from '../app/utils/jobStatus'
import { skippedLinesAdvice } from '../app/utils/importOutcome'

const doc: ExtractedDocument = {
  currency: 'BYN',
  priceIncludesVat: true,
  supplier: { name: 'X', taxId: '190000000' },
  items: [{ name: 'a', price: 10, quantity: 1, unit: 'шт', vatRate: null }]
}

function crmDeps(over: Record<string, unknown> = {}) {
  return {
    findExisting: vi.fn(async () => null as number | null),
    findCompanyByTaxId: vi.fn(async () => 42),
    findProduct: vi.fn(async () => null),
    portalVatRates: vi.fn(async () => [{ id: '1', name: 'Без НДС', rate: null }]),
    createTarget: vi.fn(async () => 555),
    setRows: vi.fn(async () => {}),
    reportErrors: vi.fn(async () => {}),
    ...over
  }
}

function deps(over = {}) {
  const m = defaultMapping()
  m.units.dictionary = { шт: 796 }
  m.product.onMissing = 'freeform'
  return {
    getMapping: vi.fn(async () => m),
    getDocument: vi.fn(async () => ({ doc, signals: {} })),
    crmSyncDeps: vi.fn(() => crmDeps()),
    setJobStatus: vi.fn(async () => {}),
    failJob: vi.fn(async () => {}),
    ...over
  }
}

describe('handleCrmSyncJob', () => {
  it('runs orchestration → done', async () => {
    const d = deps()
    const r = await handleCrmSyncJob({ memberId: 'm', jobId: 'j' }, d)
    expect(r?.created).toBe(true)
    expect(d.setJobStatus).toHaveBeenCalledWith('m', 'j', 'done', expect.stringContaining('"entityId":555'))
  })
  it('пропавший документ идёт через failJob — иначе об отказе никто не узнает', async () => {
    // Эта ветка НЕ бросает исключение, значит хук «повторы исчерпаны» не сработает: если писать
    // статус напрямую, отказ останется только в списке, который сотрудник может не открыть.
    const d = deps({ getDocument: vi.fn(async () => null) })
    expect(await handleCrmSyncJob({ memberId: 'm', jobId: 'j' }, d)).toBeNull()
    expect(d.failJob).toHaveBeenCalledWith('m', 'j', expect.stringContaining('не найден'))
    expect(d.setJobStatus).not.toHaveBeenCalled()
  })

  it('bumps dashboard counters on success (docs/created/lines/unmatched; errors handled upstream)', async () => {
    const bumpMetrics = vi.fn(async () => {})
    const d = deps({ bumpMetrics })
    await handleCrmSyncJob({ memberId: 'm', jobId: 'j' }, d)
    // 1 doc processed, 1 CRM entity created, 1 product row (doc has 1 item), supplier matched
    // (unmatched:0). No `errors` key.
    expect(bumpMetrics).toHaveBeenCalledWith('m', { docs: 1, created: 1, lines: 1, unmatched: 0 })
  })

  it('bumps docs but not created/lines on a hard error', async () => {
    const bumpMetrics = vi.fn(async () => {})
    const badDoc: ExtractedDocument = { ...doc, items: [{ name: 'a', price: 10, quantity: 1, unit: 'шт', vatRate: 20 }] }
    const d = deps({ bumpMetrics, getDocument: vi.fn(async () => ({ doc: badDoc, signals: {} })) })
    await handleCrmSyncJob({ memberId: 'm', jobId: 'j' }, d)
    expect(bumpMetrics).toHaveBeenCalledWith('m', { docs: 1, created: 0, lines: 0, unmatched: 0 })
  })

  it('bumps `unmatched` when the supplier company is not resolved', async () => {
    const bumpMetrics = vi.fn(async () => {})
    // findCompanyByTaxId → null ⇒ entity still created (freeform), but unmatched:1.
    const cd = { ...crmDeps(), findCompanyByTaxId: vi.fn(async () => null as number | null) }
    const d = deps({ bumpMetrics, crmSyncDeps: vi.fn(() => cd) })
    const r = await handleCrmSyncJob({ memberId: 'm', jobId: 'j' }, d)
    expect(r?.unmatched).toBe(true)
    expect(bumpMetrics).toHaveBeenCalledWith('m', { docs: 1, created: 1, lines: 1, unmatched: 1 })
  })

  it('idempotent redelivery counts a `skipped`, re-counts nothing else', async () => {
    const bumpMetrics = vi.fn(async () => {})
    const cd = { ...crmDeps(), findExisting: vi.fn(async () => 99 as number | null) }
    const d = deps({ bumpMetrics, crmSyncDeps: vi.fn(() => cd) })
    const r = await handleCrmSyncJob({ memberId: 'm', jobId: 'j' }, d)
    expect(r?.idempotent).toBe(true)
    // The whole document was skipped as a duplicate — count it, but do NOT re-count docs/lines.
    expect(bumpMetrics).toHaveBeenCalledWith('m', { skipped: 1 })
  })

  const twoItem: ExtractedDocument = { ...doc, items: [
    { name: 'a', price: 10, quantity: 1, unit: 'шт', vatRate: null },
    { name: 'b', price: 5, quantity: 2, unit: 'шт', vatRate: null }
  ] }

  function skipWarnMapping() {
    const m = defaultMapping()
    m.units.dictionary = { шт: 796 }
    m.product.onMissing = 'skip-warn'
    return m
  }

  it('lines uses rows actually written, not doc.items.length (skip-warn drops a line)', async () => {
    const bumpMetrics = vi.fn(async () => {})
    // 2 позиции, каталог знает только «a» → вторая пропущена → записана 1 строка из 2.
    const m = skipWarnMapping()
    const d = deps({
      bumpMetrics,
      getMapping: vi.fn(async () => m),
      getDocument: vi.fn(async () => ({ doc: twoItem, signals: {} })),
      crmSyncDeps: () => crmDeps({ findProduct: vi.fn(async (it: { name: string }) => it.name === 'a' ? 7 : null) })
    })
    await handleCrmSyncJob({ memberId: 'm', jobId: 'j' }, d)
    expect(bumpMetrics).toHaveBeenCalledWith('m', { docs: 1, created: 1, lines: 1, unmatched: 0 })
  })

  it('#373: пропущены ВСЕ строки → created 0 и статус «Ошибка», а не «Готово»', async () => {
    // Раньше здесь считалось `created:1, lines:0` — то есть счётчик успехов рос на импорте, после
    // которого в CRM не появилось ни одной строки. Это и есть #373 на уровне метрик.
    const bumpMetrics = vi.fn(async () => {})
    const setJobStatus = vi.fn(async () => {})
    const m = skipWarnMapping()
    const d = deps({ bumpMetrics, setJobStatus, getMapping: vi.fn(async () => m), getDocument: vi.fn(async () => ({ doc: twoItem, signals: {} })) })
    await handleCrmSyncJob({ memberId: 'm', jobId: 'j' }, d)
    expect(bumpMetrics).toHaveBeenCalledWith('m', { docs: 1, created: 0, lines: 0, unmatched: 0 })
    expect(setJobStatus).toHaveBeenCalledWith('m', 'j', 'error', expect.any(String))
  })

  it('a metrics-write failure never fails the job', async () => {
    const bumpMetrics = vi.fn(async () => {
      throw new Error('db down')
    })
    const d = deps({ bumpMetrics })
    const r = await handleCrmSyncJob({ memberId: 'm', jobId: 'j' }, d)
    expect(r?.created).toBe(true) // job still succeeded despite the metrics throw
  })

  it('hard error (VAT not in portal) → error status', async () => {
    const badDoc: ExtractedDocument = { ...doc, items: [{ name: 'a', price: 10, quantity: 1, unit: 'шт', vatRate: 20 }] }
    const d = deps({ getDocument: vi.fn(async () => ({ doc: badDoc, signals: {} })) })
    const r = await handleCrmSyncJob({ memberId: 'm', jobId: 'j' }, d)
    // #459: карточка-след создаётся и на отказе, поэтому «создана» больше не равно «получилось».
    // Несущее утверждение теста — СТАТУС: сотрудник обязан увидеть «Ошибка», а не «Готово».
    expect(r?.rowCount).toBe(0)
    expect(d.setJobStatus).toHaveBeenCalledWith('m', 'j', 'error', expect.stringContaining('errors'))
  })

  it('idempotent re-run (existing, no errors) → done', async () => {
    const cd = { ...crmDeps(), findExisting: vi.fn(async () => 99 as number | null) }
    const d = deps({ crmSyncDeps: vi.fn(() => cd) })
    const r = await handleCrmSyncJob({ memberId: 'm', jobId: 'j' }, d)
    expect(r?.created).toBe(false)
    expect(d.setJobStatus).toHaveBeenCalledWith('m', 'j', 'done', expect.any(String))
  })

  it('drops the stored client doc after the terminal status (cleanup)', async () => {
    const deleteDocument = vi.fn(async () => {})
    const d = deps({ deleteDocument })
    await handleCrmSyncJob({ memberId: 'm', jobId: 'j' }, d)
    expect(deleteDocument).toHaveBeenCalledWith('m', 'j')
  })
  it('cleanup failure never fails the job (best-effort)', async () => {
    const deleteDocument = vi.fn(async () => {
      throw new Error('db down')
    })
    const d = deps({ deleteDocument })
    const r = await handleCrmSyncJob({ memberId: 'm', jobId: 'j' }, d)
    expect(r?.created).toBe(true)
  })
  it('no document → no cleanup call', async () => {
    const deleteDocument = vi.fn(async () => {})
    const d = deps({ getDocument: vi.fn(async () => null), deleteDocument })
    await handleCrmSyncJob({ memberId: 'm', jobId: 'j' }, d)
    expect(deleteDocument).not.toHaveBeenCalled()
  })
  it('совет доезжает до строки задания через колонку результата (#388)', async () => {
    // Шов между ядром и экраном: компонент тестируется на сыром JSON, разбор — на сыром JSON, а
    // что сервер этот JSON действительно формирует с советом, не проверял никто. Мутация «убрать
    // advice из записи статуса» проходила при всех зелёных тестах — и совет не появился бы ни у
    // одного пользователя.
    const m = defaultMapping()
    m.units.dictionary = { шт: 796 }
    m.product.onMissing = 'skip-warn'
    const twoItems: ExtractedDocument = { ...doc, items: [
      { name: 'Гвоздь', price: 10, quantity: 1, unit: 'шт', vatRate: null },
      { name: 'Шуруп', price: 10, quantity: 1, unit: 'шт', vatRate: null }
    ] }
    const setJobStatus = vi.fn(async () => {})
    const d = deps({
      getMapping: vi.fn(async () => m),
      getDocument: vi.fn(async () => ({ doc: twoItems, signals: {} })),
      crmSyncDeps: vi.fn(() => crmDeps({ findProduct: vi.fn(async (it: { name: string }) => it.name === 'Гвоздь' ? 7 : null) })),
      setJobStatus
    })
    await handleCrmSyncJob({ memberId: 'm', jobId: 'j' }, d)
    const written = String(setJobStatus.mock.calls.at(-1)?.[3] ?? '')
    const parsed = parseJobResult(written)
    expect(parsed.advice, 'совет не доехал до строки задания').toBe(skippedLinesAdvice())
    // И НЕ продублирован в списке проблем — иначе счётчик снова соврёт.
    expect(parsed.warnings).not.toContain(skippedLinesAdvice())
  })
})

const evJob = (over: Partial<EventJob> = {}): EventJob => ({
  memberId: 'm1', event: 'ONAPPINSTALL', domain: 'p.bitrix24.ru', ts: 100,
  applicationToken: 'app', accessToken: 'ac', refreshTokenEnc: 'ENC', clientEndpoint: 'https://p.bitrix24.ru/rest/',
  expiresIn: 3600, issuedAtMs: 5, ...over
})

describe('handleEventJob (single-writer consumer)', () => {
  it('ONAPPINSTALL → savePortal(job); never deletePortal', async () => {
    const savePortal = vi.fn(async () => true)
    const deletePortal = vi.fn(async () => {})
    await handleEventJob(evJob(), { savePortal, deletePortal })
    expect(savePortal).toHaveBeenCalledWith(expect.objectContaining({ memberId: 'm1', ts: 100 }))
    expect(deletePortal).not.toHaveBeenCalled()
  })
  it('ONAPPUNINSTALL → deletePortal(memberId, ts) + purgeFiles; never savePortal', async () => {
    const savePortal = vi.fn(async () => true)
    const deletePortal = vi.fn(async () => {})
    const purgeFiles = vi.fn(async () => {})
    await handleEventJob(evJob({ event: 'ONAPPUNINSTALL', ts: 200 }), { savePortal, deletePortal, purgeFiles })
    expect(deletePortal).toHaveBeenCalledWith('m1', 200)
    expect(purgeFiles).toHaveBeenCalledWith('m1')
    expect(savePortal).not.toHaveBeenCalled()
  })
  it('a refused (stale) install does not throw', async () => {
    const savePortal = vi.fn(async () => false)
    await expect(handleEventJob(evJob(), { savePortal, deletePortal: vi.fn(async () => {}) })).resolves.toBeUndefined()
  })
  it('unknown event type is ignored (no writes)', async () => {
    const savePortal = vi.fn(async () => true)
    const deletePortal = vi.fn(async () => {})
    await handleEventJob(evJob({ event: 'ONSOMETHINGELSE' }), { savePortal, deletePortal })
    expect(savePortal).not.toHaveBeenCalled()
    expect(deletePortal).not.toHaveBeenCalled()
  })
})

describe('eventJobToSaveInput', () => {
  it('maps register creds (refreshedAtMs mirrors issuedAtMs; refresh stays encrypted)', () => {
    expect(eventJobToSaveInput(evJob())).toEqual({
      memberId: 'm1', domain: 'p.bitrix24.ru', clientEndpoint: 'https://p.bitrix24.ru/rest/',
      accessToken: 'ac', refreshTokenEnc: 'ENC', applicationToken: 'app',
      expiresIn: 3600, issuedAtMs: 5, refreshedAtMs: 5
    })
  })
  it('fills defaults for an uninstall-shaped job (no creds)', () => {
    const r = eventJobToSaveInput(evJob({ event: 'ONAPPUNINSTALL', accessToken: undefined, refreshTokenEnc: undefined, clientEndpoint: undefined, expiresIn: undefined, issuedAtMs: undefined }))
    expect(r).toMatchObject({ accessToken: '', refreshTokenEnc: '', clientEndpoint: '', expiresIn: 3600, issuedAtMs: 0, refreshedAtMs: 0 })
  })
})
