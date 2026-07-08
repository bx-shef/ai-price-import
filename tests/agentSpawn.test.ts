import { describe, expect, it, vi } from 'vitest'
import { makeAgentSpawn, type ChildLike } from '../server/agent/spawn'

// A controllable fake child process.
function fakeChild() {
  const handlers: Record<string, (a: unknown) => void> = {}
  const stdoutCbs: Array<(d: unknown) => void> = []
  const stderrCbs: Array<(d: unknown) => void> = []
  const child: ChildLike & { emit: (ev: string, a?: unknown) => void, feedOut: (s: string) => void, feedErr: (s: string) => void, killed?: string } = {
    stdout: { on: (_e, cb) => { stdoutCbs.push(cb) } },
    stderr: { on: (_e, cb) => { stderrCbs.push(cb) } },
    stdin: { end: vi.fn() },
    on: (ev, cb) => { handlers[ev] = cb },
    kill: (sig) => { child.killed = sig ?? 'SIGTERM' },
    emit: (ev, a) => handlers[ev]?.(a),
    feedOut: s => stdoutCbs.forEach(cb => cb(s)),
    feedErr: s => stderrCbs.forEach(cb => cb(s))
  }
  return child
}

describe('makeAgentSpawn', () => {
  it('collects stdout/stderr and resolves on close(0), passing sanitized env', async () => {
    const child = fakeChild()
    let seenEnv: Record<string, string> = {}
    const spawn = makeAgentSpawn({
      bin: 'claude',
      env: { PATH: '/usr/bin', DEEPSEEK_API_KEY: 'sk', DATABASE_URL: 'postgres://secret' },
      spawnFn: (_b, _a, e) => {
        seenEnv = e
        return child
      }
    })
    const p = spawn(['--print'], 'PROMPT')
    child.feedOut('{"items":[]}')
    child.feedErr('warn')
    child.emit('close', 0)
    const res = await p
    expect(res).toEqual({ code: 0, stdout: '{"items":[]}', stderr: 'warn' })
    expect(child.stdin!.end).toHaveBeenCalledWith('PROMPT')
    // env is filtered: LLM var passes, backend secret stripped
    expect(seenEnv.DEEPSEEK_API_KEY).toBe('sk')
    expect(seenEnv.DATABASE_URL).toBeUndefined()
  })

  it('kills and returns a terminal timeout on deadline', async () => {
    const child = fakeChild()
    let fire: (() => void) | null = null
    const spawn = makeAgentSpawn({
      spawnFn: () => child,
      setTimeoutFn: (cb) => {
        fire = cb as () => void
        return 1
      },
      clearTimeoutFn: () => {}
    })
    const p = spawn(['--print'], 'x')
    fire!() // trip the deadline
    const res = await p
    expect(res.code).toBe(124)
    expect(res.stderr).toBe('agent timed out')
    expect(child.killed).toBe('SIGKILL')
  })

  it('resolves once — a close after timeout is ignored', async () => {
    const child = fakeChild()
    let fire: (() => void) | null = null
    const spawn = makeAgentSpawn({
      spawnFn: () => child,
      setTimeoutFn: (cb) => {
        fire = cb as () => void
        return 1
      },
      clearTimeoutFn: () => {}
    })
    const p = spawn([], 'x')
    fire!()
    child.emit('close', 0) // late close — must not overwrite the timeout result
    const res = await p
    expect(res.code).toBe(124)
  })

  it('maps a spawn error event to a terminal failure', async () => {
    const child = fakeChild()
    const spawn = makeAgentSpawn({ spawnFn: () => child })
    const p = spawn([], 'x')
    child.emit('error', new Error('ENOENT: claude not found'))
    const res = await p
    expect(res.code).toBe(1)
    expect(res.stderr).toContain('ENOENT')
  })
})
