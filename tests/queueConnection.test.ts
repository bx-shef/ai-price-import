import { describe, expect, it } from 'vitest'
import { parseRedisUrl } from '../server/queue/connection'

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
