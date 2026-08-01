// Pure parsing of the job-id list the client asks statuses for (#260). Extracted from the route so
// the rules that actually matter — what counts as an id, how many we answer for, and what we tell the
// caller when we answer for fewer — are testable without an HTTP layer.

/** Job ids are client-generated UUIDs; anything else is not ours and is dropped. */
const JOB_ID_RE = /^[A-Za-z0-9-]{1,64}$/

/**
 * How many ids one request may ask about. The client list now lives in page memory only (localStorage
 * dropped — owner rework), so there is no persisted-history cap to mirror any more; 50 comfortably
 * covers several 10-file batches on one open page while still bounding the Redis fan-out per request.
 * Answering for fewer than asked is reported via `requested` — never silently (#260).
 */
export const MAX_IDS = 50

export interface ParsedStatusIds {
  /** Ids we will answer for (capped, newest-first as the client sent them). */
  ids: string[]
  /** How many valid ids were asked for in total — `> ids.length` means we answered for fewer. */
  requested: number
}

/**
 * Validate + cap the requested ids. Returning `requested` (not the difference) keeps the arithmetic
 * on one side: the client knows how many it asked for, but only the server knows how many survived
 * validation, so a malformed id in the browser's history can't turn into a nonsense number in the UI.
 */
export function parseStatusIds(raw: unknown, max: number = MAX_IDS): ParsedStatusIds {
  const list = Array.isArray(raw) ? raw : []
  const valid = list
    .filter((s): s is string => typeof s === 'string')
    .map(s => s.trim())
    .filter(s => JOB_ID_RE.test(s))
  return { ids: valid.slice(0, max), requested: valid.length }
}

/**
 * Wording for a poll that couldn't cover every remembered job. Pure so the numbers (which come FROM
 * the server — only it knows how many ids survived validation) are pinned by a test rather than by
 * arithmetic scattered in the composable. Empty string = nothing to say.
 */
export function truncationWarning(requested: number | undefined, answered: number | undefined): string {
  if (!Number.isFinite(requested) || !Number.isFinite(answered)) return ''
  if ((requested as number) <= (answered as number)) return ''
  return `Статус обновляется только для последних ${answered} загрузок из ${requested}. `
    + 'Уберите старые строки из списка.'
}
