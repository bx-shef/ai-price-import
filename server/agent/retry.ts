// Pure retry/backoff policy for the agent subprocess. No I/O.
// Transient provider errors (429/5xx/network) → retry with backoff+jitter;
// our own timeout and permanent faults are terminal (ported concept from legacy).

export type AgentFaultKind = 'transient' | 'terminal'

const TRANSIENT_PATTERNS = [
  /\b429\b/, /\b5\d\d\b/, /rate.?limit/i, /overloaded/i, /timeout/i,
  /ECONNRESET/i, /ETIMEDOUT/i, /ENOTFOUND/i, /EAI_AGAIN/i, /socket hang up/i
]

/** Classify an agent error string into transient (retryable) vs terminal. */
export function classifyAgentError(message: string): AgentFaultKind {
  const m = message ?? ''
  return TRANSIENT_PATTERNS.some(re => re.test(m)) ? 'transient' : 'terminal'
}

/**
 * Backoff for attempt N (1-based): exponential base*2^(n-1), capped, plus a
 * deterministic-per-input jitter fraction in [0,1) provided by the caller
 * (so the pure fn stays deterministic — the worker passes Math.random()).
 */
export function nextBackoffMs(attempt: number, jitter: number, baseMs = 1000, capMs = 30_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1))
  const j = Math.max(0, Math.min(1, jitter))
  return Math.round(exp * (0.5 + 0.5 * j)) // 50%–100% of the exponential window
}

/** Should we retry: transient AND under the attempt budget. */
export function shouldRetry(kind: AgentFaultKind, attempt: number, maxAttempts = 3): boolean {
  return kind === 'transient' && attempt < maxAttempts
}
