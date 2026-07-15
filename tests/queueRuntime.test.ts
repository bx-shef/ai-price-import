import { describe, expect, it } from 'vitest'
import { envFlag, queueRuntimeConfig } from '../server/queue/runtime'

describe('envFlag', () => {
  it('unset/empty → default', () => {
    expect(envFlag(undefined, true)).toBe(true)
    expect(envFlag('', true)).toBe(true)
    expect(envFlag('  ', false)).toBe(false)
  })
  it('0/false/no/off (any case) → false; anything else → true', () => {
    for (const v of ['0', 'false', 'No', 'OFF']) expect(envFlag(v, true)).toBe(false)
    for (const v of ['1', 'true', 'yes', 'on', 'x']) expect(envFlag(v, false)).toBe(true)
  })
})

describe('queueRuntimeConfig', () => {
  it('defaults = single container (workers + cron on)', () => {
    expect(queueRuntimeConfig({})).toEqual({ workers: true, cron: true })
  })
  it('worker role: QUEUE_CRON=0 (drain throughput, no event worker)', () => {
    expect(queueRuntimeConfig({ QUEUE_CRON: '0' })).toEqual({ workers: true, cron: false })
  })
  it('primary role: QUEUE_WORKERS=0 (API + event worker only)', () => {
    expect(queueRuntimeConfig({ QUEUE_WORKERS: '0' })).toEqual({ workers: false, cron: true })
  })
})
