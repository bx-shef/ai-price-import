import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Verify the SEAM: liveExtractRunners.* → run() actually spawns with the sanitized env
// (no backend secrets), not just that subprocessEnv() is correct in isolation (GH #99).
const spawnMock = vi.fn()
vi.mock('node:child_process', () => ({ spawn: (...a: unknown[]) => spawnMock(...a) }))

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter, stderr: EventEmitter, kill: () => void }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => undefined
  queueMicrotask(() => {
    child.stdout.emit('data', 'ok')
    child.emit('close', 0)
  })
  return child
}

afterEach(() => {
  spawnMock.mockReset()
})

describe('run() spawns extraction binaries with a secret-free env (GH #99)', () => {
  it('pdftotext gets PATH/LANG but NOT DATABASE_URL/B24 secrets', async () => {
    spawnMock.mockImplementation(() => fakeChild())
    const orig = { ...process.env }
    process.env.PATH = '/usr/bin'
    process.env.DATABASE_URL = 'postgres://secret'
    process.env.B24_TOKEN_ENC_KEY = 'enc'
    process.env.B24_CLIENT_SECRET = 'cs'
    try {
      const { liveExtractRunners } = await import('../server/utils/extractRunners')
      await liveExtractRunners.pdfToText('/tmp/x.pdf')
      expect(spawnMock).toHaveBeenCalled()
      const opts = spawnMock.mock.calls[0]![2] as { env: Record<string, string> }
      expect(opts.env.PATH).toBe('/usr/bin')
      expect(opts.env.DATABASE_URL).toBeUndefined()
      expect(opts.env.B24_TOKEN_ENC_KEY).toBeUndefined()
      expect(opts.env.B24_CLIENT_SECRET).toBeUndefined()
    } finally {
      process.env = orig
    }
  })
})
