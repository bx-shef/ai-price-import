import { describe, expect, it, vi } from 'vitest'
import { agentEnvelopeError, buildAgentPrompt, parseAgentOutput, runAgent, type AgentProcResult } from '../server/agent/runAgent'
import { MAX_ITEMS } from '../app/utils/extractedDocument'

const DOC = '{"currency":"BYN","items":[{"name":"Болт","price":10,"quantity":2}]}'

function deps(spawn: (args: string[], stdin: string) => Promise<AgentProcResult>) {
  return { spawn: vi.fn(spawn), sleep: vi.fn(async () => {}), random: () => 0 }
}

describe('buildAgentPrompt', () => {
  it('frames the document after the instructions', () => {
    const p = buildAgentPrompt('INSTR', 'DOCTEXT')
    expect(p.startsWith('INSTR')).toBe(true)
    expect(p).toContain('=== ДОКУМЕНТ ===')
    expect(p.endsWith('DOCTEXT')).toBe(true)
  })
})

describe('parseAgentOutput', () => {
  it('reads a plain JSON print', () => {
    expect(parseAgentOutput(`noise ${DOC}`)).toMatchObject({ currency: 'BYN' })
  })
  it('unwraps the Claude Code result envelope', () => {
    const env = JSON.stringify({ type: 'result', is_error: false, result: `Here:\n${DOC}` })
    expect(parseAgentOutput(env)).toMatchObject({ currency: 'BYN' })
  })
  it('null when envelope result has no json', () => {
    expect(parseAgentOutput(JSON.stringify({ result: 'sorry, nothing' }))).toBeNull()
  })
  it('null on no json at all', () => {
    expect(parseAgentOutput('plain text')).toBeNull()
  })
})

describe('runAgent', () => {
  it('success on first attempt', async () => {
    const d = deps(async () => ({ code: 0, stdout: DOC, stderr: '' }))
    const r = await runAgent({ documentText: 'x', instructions: 'i' }, d)
    expect(r.ok).toBe(true)
    expect(r.attempts).toBe(1)
    expect(r.document?.items).toHaveLength(1)
    expect(d.sleep).not.toHaveBeenCalled()
  })

  it('retries a transient failure then succeeds (with backoff sleep)', async () => {
    let n = 0
    const d = deps(async () => {
      n++
      return n === 1 ? { code: 1, stdout: '', stderr: 'HTTP 503 overloaded' } : { code: 0, stdout: DOC, stderr: '' }
    })
    const r = await runAgent({ documentText: 'x', instructions: 'i' }, d)
    expect(r.ok).toBe(true)
    expect(r.attempts).toBe(2)
    expect(d.sleep).toHaveBeenCalledTimes(1)
  })

  it('gives up after the attempt budget on persistent transient errors', async () => {
    const d = deps(async () => ({ code: 1, stdout: '', stderr: 'ECONNRESET' }))
    const r = await runAgent({ documentText: 'x', instructions: 'i', maxAttempts: 3 }, d)
    expect(r.ok).toBe(false)
    expect(r.attempts).toBe(3)
    expect(d.spawn).toHaveBeenCalledTimes(3)
  })

  it('terminal error → no retry', async () => {
    const d = deps(async () => ({ code: 1, stdout: '', stderr: 'invalid api key' }))
    const r = await runAgent({ documentText: 'x', instructions: 'i' }, d)
    expect(r.ok).toBe(false)
    expect(r.attempts).toBe(1)
    expect(d.spawn).toHaveBeenCalledTimes(1)
  })

  it('clean run but no usable document → terminal failure', async () => {
    const d = deps(async () => ({ code: 0, stdout: '{"items":[]}', stderr: '' }))
    const r = await runAgent({ documentText: 'x', instructions: 'i' }, d)
    expect(r.ok).toBe(false)
    expect(r.attempts).toBe(1)
    expect(r.error).toContain('не извлёк')
  })

  it('a thrown spawn error is treated as transient', async () => {
    let n = 0
    const d = deps(async () => {
      n++
      if (n === 1) throw new Error('socket hang up')
      return { code: 0, stdout: DOC, stderr: '' }
    })
    const r = await runAgent({ documentText: 'x', instructions: 'i' }, d)
    expect(r.ok).toBe(true)
    expect(r.attempts).toBe(2)
  })

  it('retries an exit-0 API-error envelope (transient), then succeeds', async () => {
    let n = 0
    const d = deps(async () => {
      n++
      return n === 1
        ? { code: 0, stdout: JSON.stringify({ is_error: true, result: 'API Error: 529 overloaded' }), stderr: '' }
        : { code: 0, stdout: DOC, stderr: '' }
    })
    const r = await runAgent({ documentText: 'x', instructions: 'i' }, d)
    expect(r.ok).toBe(true)
    expect(r.attempts).toBe(2)
    expect(d.sleep).toHaveBeenCalledTimes(1)
  })

  it('too many items → hard error, no retry (no silent truncation)', async () => {
    const huge = JSON.stringify({ items: Array.from({ length: MAX_ITEMS + 1 }, (_, i) => ({ name: `P${i}`, price: 1, quantity: 1 })) })
    const d = deps(async () => ({ code: 0, stdout: huge, stderr: '' }))
    const r = await runAgent({ documentText: 'x', instructions: 'i' }, d)
    expect(r.ok).toBe(false)
    expect(r.attempts).toBe(1)
    expect(r.error).toContain('слишком много позиций')
  })

  it('bounds a huge error string (no echoed content in status)', async () => {
    const d = deps(async () => ({ code: 1, stdout: '', stderr: 'x'.repeat(5000) }))
    const r = await runAgent({ documentText: 'x', instructions: 'i', maxAttempts: 1 }, d)
    expect(r.error!.length).toBeLessThanOrEqual(301)
  })
})

describe('agentEnvelopeError', () => {
  it('flags an is_error envelope', () => {
    expect(agentEnvelopeError(JSON.stringify({ is_error: true, result: 'API Error: 500' }))).toContain('API Error')
  })
  it('flags API-error text without is_error', () => {
    expect(agentEnvelopeError(JSON.stringify({ result: 'overloaded, try later' }))).toContain('overloaded')
  })
  it('empty for a normal document (has items)', () => {
    expect(agentEnvelopeError(DOC)).toBe('')
    expect(agentEnvelopeError(JSON.stringify({ is_error: false, result: 'ok' }))).toBe('')
  })
})
