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

/** Least-privilege tool allowlist: ONLY the MCP tools, everything else denied. */
export function agentAllowedTools(): string[] {
  return MCP_TOOL_NAMES.map(t => `mcp__procure-ai__${t}`)
}

/**
 * EXHAUSTIVE denylist of every built-in Claude Code tool. This is the REAL gate:
 * an empty `--allowedTools` is NOT deny-all (Read/Glob/Grep/Task need no permission
 * and stay callable in headless `--print` mode), so the extractor must explicitly
 * deny every tool — otherwise a prompt-injected document could `Read` the backend
 * `.env`/`/proc/self/environ` and smuggle DATABASE_URL / B24_TOKEN_ENC_KEY into the
 * output. `--disallowedTools` takes precedence, so this holds even if an allowlist
 * entry overlaps. Keep in sync with new Claude Code tools; the env allowlist
 * (`agentSpawnEnv`) is the defense-in-depth backstop if one is ever missed. */
export function agentDisallowedTools(): string[] {
  return [
    'Bash', 'BashOutput', 'KillShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
    'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'TodoWrite',
    'SlashCommand', 'ExitPlanMode'
  ]
}

/** LLM-provider env vars the agent subprocess may see. Everything else — DB creds,
 * the token-encryption key, B24 client secret, app token — is stripped so a
 * prompt-injected document cannot exfiltrate them even if a tool slips the denylist.
 * The worker MUST spawn the agent with exactly this env (never the full process env). */
const AGENT_ENV_ALLOW = [
  'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'TERM',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
  'CLAUDE_CODE_USE_BEDROCK', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS'
] as const

/** Build the minimal, secret-free environment for the agent subprocess. */
export function agentSpawnEnv(full: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of AGENT_ENV_ALLOW) {
    const v = full[k]
    if (v != null && v !== '') out[k] = String(v)
  }
  return out
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
  // Extractor mode: empty allowlist + EXHAUSTIVE disallow (the real gate) → zero tools.
  const mcp = mcpConfigPath
    ? ['--mcp-config', mcpConfigPath, '--allowedTools', agentAllowedTools().join(',')]
    : ['--allowedTools', '']
  return [...base, ...mcp, '--disallowedTools', agentDisallowedTools().join(',')]
}
