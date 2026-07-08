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

/** Least-privilege tool allowlist: Read + the MCP tools, everything else denied. */
export function agentAllowedTools(): string[] {
  return ['Read', ...MCP_TOOL_NAMES.map(t => `mcp__procure-ai__${t}`)]
}

export function agentDisallowedTools(): string[] {
  return ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch']
}

/** Build headless Claude Code CLI args (prompt goes on stdin, not argv → no E2BIG). */
export function buildAgentArgs(mcpConfigPath: string): string[] {
  return [
    '--print', '--bare', '--output-format', 'json',
    '--mcp-config', mcpConfigPath,
    '--allowedTools', agentAllowedTools().join(','),
    '--disallowedTools', agentDisallowedTools().join(',')
  ]
}
