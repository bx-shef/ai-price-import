import { buildAgentArgs } from './mcpConfig'
import { extractJson } from './extractJson'
import { classifyAgentError, nextBackoffMs, shouldRetry } from './retry'
import { validateExtractedDocument } from '~/utils/extractedDocument'
import type { ExtractedDocument } from '~/types/document'

// Orchestrate one extraction run of the headless agent (Claude Code / DeepSeek).
// Pure control-flow with injected I/O (spawn/sleep/jitter) → unit-tested with fakes.
// The agent is a PURE extractor: document on stdin, JSON out, no Bitrix24 access.
// docs/redesign 02 §«Решения по проводке crm-sync».

const DOC_DELIM = '=== ДОКУМЕНТ ==='

export interface AgentProcResult { code: number, stdout: string, stderr: string }

/** Spawn the headless agent (args + stdin prompt → result). Injected: worker.ts wires child_process. */
export type AgentSpawn = (args: string[], stdin: string) => Promise<AgentProcResult>

export interface RunAgentDeps {
  spawn: AgentSpawn
  /** Backoff sleep between transient retries (injected → tests don't wait). */
  sleep: (ms: number) => Promise<void>
  /** Jitter source for backoff in [0,1) (injected → deterministic tests). */
  random: () => number
}

export interface RunAgentInput {
  documentText: string
  /** Extraction system prompt (languages, tax-id rules, VAT uniformity, …). */
  instructions: string
  maxAttempts?: number
}

export interface RunAgentOutcome {
  ok: boolean
  document: ExtractedDocument | null
  attempts: number
  error?: string
}

/** Compose the stdin prompt: instructions + framed document (kept off argv/ps). */
export function buildAgentPrompt(instructions: string, documentText: string): string {
  return `${instructions}\n\n${DOC_DELIM}\n${documentText}`
}

/**
 * Unwrap the agent stdout to the raw extracted JSON. Handles both a plain JSON
 * print and the Claude Code result envelope ({…, "result": "<text with our json>"}).
 */
export function parseAgentOutput(stdout: string): unknown {
  const first = extractJson(stdout)
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    const o = first as Record<string, unknown>
    // Envelope: has a `result` string payload and is not itself the document.
    if (!('items' in o) && typeof o.result === 'string') return extractJson(o.result)
  }
  return first
}

/** Run the extraction agent with transient-retry. Never throws — returns an outcome. */
export async function runAgent(input: RunAgentInput, deps: RunAgentDeps): Promise<RunAgentOutcome> {
  const args = buildAgentArgs() // extractor mode: no MCP config, no tools
  const stdin = buildAgentPrompt(input.instructions, input.documentText)
  const maxAttempts = input.maxAttempts ?? 3
  let attempt = 0
  let lastError = 'agent failed'
  while (attempt < maxAttempts) {
    attempt++
    let res: AgentProcResult
    try {
      res = await deps.spawn(args, stdin)
    } catch (e) {
      res = { code: 1, stdout: '', stderr: e instanceof Error ? e.message : String(e) }
    }

    if (res.code !== 0) {
      lastError = res.stderr || `agent exited ${res.code}`
      if (shouldRetry(classifyAgentError(lastError), attempt, maxAttempts)) {
        await deps.sleep(nextBackoffMs(attempt, deps.random()))
        continue
      }
      return { ok: false, document: null, attempts: attempt, error: lastError }
    }

    const doc = validateExtractedDocument(parseAgentOutput(res.stdout))
    if (doc) return { ok: true, document: doc, attempts: attempt }
    // Clean exit but no usable tabular part → terminal (same input won't re-extract).
    return { ok: false, document: null, attempts: attempt, error: 'агент не извлёк табличную часть' }
  }
  return { ok: false, document: null, attempts: attempt, error: lastError }
}
