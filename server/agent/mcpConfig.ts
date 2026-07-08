import { MCP_TOOL_NAMES } from '../../mcp/tools'

// Pure builders for the agent (Claude Code) invocation. The portal OAuth token is
// NEVER passed here — only a short-lived per-job bearer to the MCP server, written
// to a 0600 file. The MCP server resolves the real token by member_id server-side.
// docs/redesign 02 §«MCP: авторизация и токены».

export interface McpConfigInput {
  /** Internal MCP server URL (not published externally). */
  mcpUrl: string
  /** Short-lived per-job bearer authorising agent→MCP (NOT the Bitrix24 token). */
  bearer: string
}

/** Build the MCP client config object written to a 0600 temp file for the agent. */
export function buildMcpConfig(input: McpConfigInput): Record<string, unknown> {
  return {
    mcpServers: {
      'procure-ai': {
        type: 'http',
        url: input.mcpUrl,
        headers: { Authorization: `Bearer ${input.bearer}` }
      }
    }
  }
}

/** Least-privilege tool allowlist: ONLY the MCP tools, everything else denied.
 * The document is delivered on stdin (not a file), so the agent needs no `Read`
 * — dropping it removes the file-read/exfil surface for prompt-injected documents. */
export function agentAllowedTools(): string[] {
  return MCP_TOOL_NAMES.map(t => `mcp__procure-ai__${t}`)
}

export function agentDisallowedTools(): string[] {
  return ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch']
}

/**
 * Build headless Claude Code CLI args (prompt goes on stdin, not argv → no E2BIG).
 *
 * MVP extraction mode (no `mcpConfigPath`): the agent is a PURE text→JSON extractor
 * with NO Bitrix24 access — every built-in tool denied, no MCP server. An untrusted
 * document fed to the LLM can then only emit JSON; it cannot touch the portal or
 * exfiltrate. The deterministic supplier/product lookup + CRM write run in crm-sync
 * over the abstract tool bodies (docs/redesign 02 §«Решения по проводке crm-sync»).
 *
 * With `mcpConfigPath`: the documented agent→MCP-over-HTTP path (per-job bearer),
 * reserved for a future mode where the LLM drives enrichment.
 */
export function buildAgentArgs(mcpConfigPath?: string): string[] {
  const base = ['--print', '--bare', '--output-format', 'json']
  const mcp = mcpConfigPath
    ? ['--mcp-config', mcpConfigPath, '--allowedTools', agentAllowedTools().join(',')]
    : ['--allowedTools', ''] // extractor: empty allowlist → no tools grantable
  return [...base, ...mcp, '--disallowedTools', agentDisallowedTools().join(',')]
}
