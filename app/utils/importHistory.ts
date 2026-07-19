// Client-side history of the employee's own import jobs — the SINGLE source of truth for the /app
// list AND the feedback-already-sent flag, keyed by jobId. Lives in the browser's localStorage (not
// the server): the status list is only useful to the person who ran the import, and the server keeps
// nothing but the ephemeral per-job status the client polls. Pure over an injected Storage-like +
// clock so it is unit-testable without a browser.

/** One remembered job: what the employee uploaded + whether they've rated it (feedback kind). */
export interface ImportHistoryEntry {
  jobId: string
  fileName: string
  /** ms epoch when it was added (drives ordering + TTL prune). */
  at: number
  /** The rating the employee already gave for this job, if any (suppresses re-asking). */
  feedback?: 'up' | 'down'
}

/** Minimal localStorage surface (getItem/setItem) — injected so the core stays testable. */
export interface StorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

const KEY = 'procure:import:history'
const MAX_ENTRIES = 50
/** Drop entries older than this (slightly outlives the server's job TTL so a finished row lingers). */
const TTL_MS = 7 * 24 * 60 * 60 * 1000

function isKind(v: unknown): v is 'up' | 'down' {
  return v === 'up' || v === 'down'
}

/** Parse + validate + TTL-prune the stored list. Newest-first. Never throws (bad JSON → []). */
export function readHistory(storage: StorageLike, now: number = Date.now()): ImportHistoryEntry[] {
  let raw: unknown
  try {
    raw = JSON.parse(storage.getItem(KEY) ?? '[]')
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const cutoff = now - TTL_MS
  return raw
    .filter((e): e is ImportHistoryEntry =>
      !!e && typeof (e as ImportHistoryEntry).jobId === 'string' && typeof (e as ImportHistoryEntry).at === 'number')
    .filter(e => e.at >= cutoff)
    .map(e => ({ jobId: e.jobId, fileName: String(e.fileName ?? ''), at: e.at, ...(isKind(e.feedback) ? { feedback: e.feedback } : {}) }))
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_ENTRIES)
}

function write(storage: StorageLike, entries: ImportHistoryEntry[]): void {
  try {
    storage.setItem(KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)))
  } catch { /* quota / disabled storage → best-effort, history just isn't persisted */ }
}

/** Record a freshly-uploaded job (or refresh its fileName/time). Keeps any existing feedback flag. */
export function addImportJob(storage: StorageLike, jobId: string, fileName: string, now: number = Date.now()): void {
  if (!jobId) return
  const prev = readHistory(storage, now)
  const existing = prev.find(e => e.jobId === jobId)
  const entry: ImportHistoryEntry = { jobId, fileName, at: now, ...(existing?.feedback ? { feedback: existing.feedback } : {}) }
  write(storage, [entry, ...prev.filter(e => e.jobId !== jobId)])
}

/** Mark that the employee gave `kind` feedback for a job (upserts a minimal entry if unknown). */
export function markImportFeedback(storage: StorageLike, jobId: string, kind: 'up' | 'down', now: number = Date.now()): void {
  if (!jobId) return
  const prev = readHistory(storage, now)
  const existing = prev.find(e => e.jobId === jobId)
  const entry: ImportHistoryEntry = { jobId, fileName: existing?.fileName ?? '', at: existing?.at ?? now, feedback: kind }
  write(storage, [entry, ...prev.filter(e => e.jobId !== jobId)])
}

/** The feedback kind already given for a job, or undefined (→ the widget may still ask). */
export function importFeedbackKind(storage: StorageLike, jobId: string, now: number = Date.now()): 'up' | 'down' | undefined {
  return readHistory(storage, now).find(e => e.jobId === jobId)?.feedback
}

/** jobIds the client should poll status for (newest-first, capped). */
export function importJobIds(storage: StorageLike, now: number = Date.now()): string[] {
  return readHistory(storage, now).map(e => e.jobId)
}
