import { describe, expect, it } from 'vitest'
import { agentAllowedTools, agentDisallowedTools, buildAgentArgs, buildMcpConfig } from '../server/agent/mcpConfig'
import { extractJson } from '../server/agent/extractJson'

describe('mcpConfig', () => {
  it('builds http MCP config with per-job bearer (NOT a portal token)', () => {
    const cfg = buildMcpConfig({ mcpUrl: 'http://mcp:3000/mcp', bearer: 'job-bearer' }) as { mcpServers: { 'procure-ai': { type: string, url: string, headers: { Authorization: string } } } }
    const s = cfg.mcpServers['procure-ai']
    expect(s.type).toBe('http')
    expect(s.headers.Authorization).toBe('Bearer job-bearer')
  })
  it('allowlist = ONLY mcp tools (no Read); denies dangerous tools', () => {
    expect(agentAllowedTools()).toContain('mcp__procure-ai__find_supplier')
    expect(agentAllowedTools()).not.toContain('Read') // no file-read/exfil surface
    expect(agentDisallowedTools()).toEqual(expect.arrayContaining(['Bash', 'Write', 'WebFetch']))
  })
  it('builds headless args with mcp-config + allowlist (future enrichment mode)', () => {
    const args = buildAgentArgs('/tmp/cfg.json')
    expect(args).toEqual(expect.arrayContaining(['--print', '--mcp-config', '/tmp/cfg.json', '--allowedTools']))
  })
  it('extractor mode (no mcp-config): empty allowlist, no --mcp-config, tools denied', () => {
    const args = buildAgentArgs()
    expect(args).not.toContain('--mcp-config')
    // --allowedTools present but empty → nothing grantable
    const ai = args.indexOf('--allowedTools')
    expect(ai).toBeGreaterThanOrEqual(0)
    expect(args[ai + 1]).toBe('')
    expect(args).toContain('--disallowedTools')
  })
})

describe('extractJson', () => {
  it('extracts the last balanced JSON object', () => {
    expect(extractJson('noise before {"a":1,"b":{"c":2}} trailing')).toEqual({ a: 1, b: { c: 2 } })
  })
  it('handles braces inside strings', () => {
    expect(extractJson('log {"name":"a}b{c","ok":true}')).toEqual({ name: 'a}b{c', ok: true })
  })
  it('handles escaped quotes (odd + even counts)', () => {
    expect(extractJson('{"v":"5\\" pipe"}')).toEqual({ v: '5" pipe' })
    expect(extractJson('log {"name":"ООО \\"Ромашка\\"","taxId":"190"}')).toEqual({ name: 'ООО "Ромашка"', taxId: '190' })
    expect(extractJson('{"note":"ends with quote\\""}')).toEqual({ note: 'ends with quote"' })
  })
  it('selects the last complete top-level object', () => {
    expect(extractJson('{"a":1} noise {"b":2}')).toEqual({ b: 2 })
  })
  it('null on no/invalid json / oversize', () => {
    expect(extractJson('no json here')).toBeNull()
    expect(extractJson('{broken')).toBeNull()
    expect(extractJson('')).toBeNull()
    expect(extractJson('{"a":1}'.padEnd(2_000_001, ' '))).toBeNull()
  })
})
