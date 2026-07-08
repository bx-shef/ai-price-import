import { spawn as nodeSpawn } from 'node:child_process'
import { agentSpawnEnv } from './mcpConfig'
import type { AgentProcResult, AgentSpawn } from './runAgent'

// Live agent subprocess runner. Two guarantees enforced here:
//  1. SANITIZED ENV — the child sees only agentSpawnEnv() (LLM-provider vars), never
//     DATABASE_URL / B24_TOKEN_ENC_KEY / B24_CLIENT_SECRET (prompt-injection exfil guard).
//  2. HARD TIMEOUT — killed on deadline; our own timeout is terminal (no retry).
// The spawn primitive + clock are injectable → the collect/timeout logic is unit-tested.

export const AGENT_TIMEOUT_MS = 120_000

/** Minimal child-process surface the runner needs (Node ChildProcess satisfies it). */
export interface ChildLike {
  stdout: { on: (ev: 'data', cb: (d: unknown) => void) => void } | null
  stderr: { on: (ev: 'data', cb: (d: unknown) => void) => void } | null
  stdin: { end: (s: string) => void } | null
  on: (ev: 'error' | 'close', cb: (arg: unknown) => void) => void
  kill: (sig?: string) => void
}

export type SpawnPrimitive = (bin: string, args: string[], env: Record<string, string>) => ChildLike

export interface AgentSpawnOptions {
  bin?: string
  timeoutMs?: number
  /** Full env to filter through agentSpawnEnv (defaults to process.env). */
  env?: Record<string, string | undefined>
  /** Injectable for tests; defaults to node:child_process spawn. */
  spawnFn?: SpawnPrimitive
  setTimeoutFn?: (cb: () => void, ms: number) => unknown
  clearTimeoutFn?: (h: unknown) => void
}

/** Build an AgentSpawn (args + stdin → result) bound to a sanitized env + timeout. */
export function makeAgentSpawn(opts: AgentSpawnOptions = {}): AgentSpawn {
  const bin = opts.bin ?? process.env.AGENT_BIN ?? 'claude'
  const timeoutMs = opts.timeoutMs ?? AGENT_TIMEOUT_MS
  const env = agentSpawnEnv(opts.env ?? (process.env as Record<string, string | undefined>))
  const spawnFn: SpawnPrimitive = opts.spawnFn ?? ((b, a, e) => nodeSpawn(b, a, { env: e, stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as ChildLike)
  const setT = opts.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms))
  const clearT = opts.clearTimeoutFn ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))

  return (args, stdin) => new Promise<AgentProcResult>((resolve) => {
    const child = spawnFn(bin, args, env)
    let out = ''
    let err = ''
    let done = false
    const finish = (r: AgentProcResult) => {
      if (done) return
      done = true
      clearT(timer)
      resolve(r)
    }
    const timer = setT(() => {
      child.kill('SIGKILL')
      // "agent timed out" is classified terminal (our deadline, not a provider blip).
      finish({ code: 124, stdout: out, stderr: 'agent timed out' })
    }, timeoutMs)
    child.stdout?.on('data', (d) => {
      out += String(d)
    })
    child.stderr?.on('data', (d) => {
      err += String(d)
    })
    child.on('error', e => finish({ code: 1, stdout: out, stderr: errMessage(e) }))
    child.on('close', code => finish({ code: typeof code === 'number' ? code : 0, stdout: out, stderr: err }))
    child.stdin?.end(stdin)
  })
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e ?? 'spawn error')
}
