import { describe, expect, it } from 'vitest'
import { QUEUE_DEFAULT_JOB_OPTIONS, parseRedisUrl } from '../server/queue/connection'

describe('parseRedisUrl', () => {
  it('defaults port 6379; parses password/username', () => {
    expect(parseRedisUrl('redis://host')).toEqual({ host: 'host', port: 6379 })
    expect(parseRedisUrl('redis://:secret@h:6380')).toEqual({ host: 'h', port: 6380, password: 'secret' })
    expect(parseRedisUrl('redis://user:pw@h')).toEqual({ host: 'h', port: 6379, username: 'user', password: 'pw' })
  })
  it('null on unset/malformed', () => {
    expect(parseRedisUrl(undefined)).toBeNull()
    expect(parseRedisUrl('')).toBeNull()
    expect(parseRedisUrl('::::not a url')).toBeNull()
  })
})

describe('QUEUE_DEFAULT_JOB_OPTIONS (retention the alert rules depend on)', () => {
  it('keeps retention NUMERIC — queueAlert.ts rejects completed/failed deltas because of it', () => {
    // A boolean here would change the meaning of the counters: `true` deletes everything (the sets
    // are always empty), `false` keeps everything (they grow without bound). Either way the header
    // reasoning in server/utils/queueAlert.ts stops holding, and the /queues screen changes shape.
    expect(typeof QUEUE_DEFAULT_JOB_OPTIONS.removeOnComplete).toBe('number')
    expect(typeof QUEUE_DEFAULT_JOB_OPTIONS.removeOnFail).toBe('number')
    expect(QUEUE_DEFAULT_JOB_OPTIONS.removeOnComplete).toBe(1000)
    expect(QUEUE_DEFAULT_JOB_OPTIONS.removeOnFail).toBe(5000)
  })
  it('failed tail outlives the completed tail (a failure must stay visible longer)', () => {
    expect(QUEUE_DEFAULT_JOB_OPTIONS.removeOnFail).toBeGreaterThan(QUEUE_DEFAULT_JOB_OPTIONS.removeOnComplete)
  })
  it('retries: 3 attempts with a GROWING pause (#267)', () => {
    expect(QUEUE_DEFAULT_JOB_OPTIONS.attempts).toBe(3)
    expect(QUEUE_DEFAULT_JOB_OPTIONS.backoff.type).toBe('exponential')
    expect(QUEUE_DEFAULT_JOB_OPTIONS.backoff.delay).toBeGreaterThan(0)
  })
})
