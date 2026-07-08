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
  it('allowlist = Read + mcp tools; denies dangerous tools', () => {
    expect(agentAllowedTools()).toContain('mcp__procure-ai__find_supplier')
    expect(agentAllowedTools()).toContain('Read')
    expect(agentDisallowedTools()).toEqual(expect.arrayContaining(['Bash', 'Write', 'WebFetch']))
  })
  it('builds headless args with mcp-config + allowlist', () => {
    const args = buildAgentArgs('/tmp/cfg.json')
    expect(args).toEqual(expect.arrayContaining(['--print', '--mcp-config', '/tmp/cfg.json', '--allowedTools']))
  })
})

describe('extractJson', () => {
  it('extracts the last balanced JSON object', () => {
    expect(extractJson('noise before {"a":1,"b":{"c":2}} trailing')).toEqual({ a: 1, b: { c: 2 } })
  })
  it('handles braces inside strings', () => {
    expect(extractJson('log {"name":"a}b{c","ok":true}')).toEqual({ name: 'a}b{c', ok: true })
  })
  it('null on no/invalid json', () => {
    expect(extractJson('no json here')).toBeNull()
    expect(extractJson('{broken')).toBeNull()
    expect(extractJson('')).toBeNull()
  })
})
