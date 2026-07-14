import { describe, expect, it } from 'vitest'
import { pollDemoJob, type DemoPollResponse } from '../app/utils/demoPoll'
import type { DemoResult } from '../app/utils/demoExtract'

const RESULT = { docType: 'invoice', docTypeLabel: 'счёт', items: [], totals: {}, language: 'ru', warnings: [] } as unknown as DemoResult

/** Deterministic clock + no-op sleep; `now` advances by `step` on each sleep. */
function harness(responses: DemoPollResponse[], step = 2000) {
  let t = 0
  let i = 0
  return {
    deps: {
      fetchResult: async () => responses[Math.min(i++, responses.length - 1)]!,
      sleep: async () => { t += step },
      now: () => t
    },
    calls: () => i
  }
}

describe('pollDemoJob', () => {
  it('resolves with the result once the job is done', async () => {
    const h = harness([{ status: 'pending' }, { status: 'pending' }, { status: 'done', result: RESULT }])
    await expect(pollDemoJob('id', h.deps)).resolves.toEqual(RESULT)
    expect(h.calls()).toBe(3)
  })

  it('rejects with the server message on error status', async () => {
    const h = harness([{ status: 'error', error: 'Ошибка обработки документа.' }])
    await expect(pollDemoJob('id', h.deps)).rejects.toThrow('Ошибка обработки документа.')
  })

  it('rejects when the job expired (404 body carries only {error})', async () => {
    const h = harness([{ error: 'Задача не найдена или устарела. Загрузите файл заново.' }])
    await expect(pollDemoJob('id', h.deps)).rejects.toThrow('устарела')
  })

  it('gives up after the timeout with an honest message', async () => {
    const h = harness([{ status: 'pending' }], 2000) // always pending
    await expect(pollDemoJob('id', h.deps, 2000, 6000)).rejects.toThrow('слишком долго')
  })
})
