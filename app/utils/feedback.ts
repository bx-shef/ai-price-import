// Pure builder for the «сотрудник» feedback channel (channel 1 of #182): an employee rates the
// import result 👍/👎 with an optional comment → a GitHub issue in the configured RECEIVING repo.
// Ported from legacy/backend/feedback.js (security-critical sanitization kept verbatim).
//
// PRIVACY: the comment is employee-written free text and MAY contain client context. The receiving
// repo (GITHUB_FEEDBACK_REPO) MUST therefore be a PRIVATE repo — never the public code repo. The
// builder keeps the comment (that's the point) but renders it INERT (hostile-char-stripped +
// HTML-escaped inside <pre><code>) so it can't Trojan-Source the issue list or inject markdown.

/** 👍 / 👎 — the two employee ratings. RU words for the issue. */
export const FEEDBACK_KINDS = { up: 'положительный 👍', down: 'отрицательный 👎' } as const
export type FeedbackKind = keyof typeof FEEDBACK_KINDS

export const MAX_COMMENT_LENGTH = 5000

// Hostile / confusing chars, spelled out with \u / \x escapes so a reviewer can verify what is
// stripped WITHOUT trusting invisible code points in the source (a literal here would itself be a
// Trojan-Source vector against the reviewer): C0 controls except tab/LF/CR; bidi overrides
// (U+202A..U+202E, U+2066..U+2069), ALM (U+061C); zero-width/BOM (U+200B..U+200D, U+FEFF); word
// joiner + invisible operators (U+2060..U+2064); line/paragraph separators (U+2028/U+2029).
// eslint-disable-next-line no-control-regex
const HOSTILE_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\u061c\u200b-\u200d\u2028-\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g

/** Remove C0 controls, bidi overrides, zero-widths and BOM from arbitrary user text. */
export function stripHostileChars(input: unknown): string {
  return String(input ?? '').replace(HOSTILE_CHARS, '')
}

/** Strip hostile chars + truncate the comment to a sane maximum. */
export function sanitizeComment(input: unknown): string {
  const stripped = stripHostileChars(input)
  if (stripped.length <= MAX_COMMENT_LENGTH) return stripped
  return `${stripped.slice(0, MAX_COMMENT_LENGTH)}…\n\n[truncated to ${MAX_COMMENT_LENGTH} characters]`
}

/** Make text inert for a GitHub issue body: &, <, > escaped (defence-in-depth in a code block). */
export function escapeHtml(input: unknown): string {
  return String(input ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** Canonical kind if recognised, else null (the route rejects null with a 400). */
export function normalizeKind(kind: unknown): FeedbackKind | null {
  return kind === 'up' || kind === 'down' ? kind : null
}

export interface IssuePayload { title: string, body: string, labels: string[] }

/**
 * Stable, opaque dedup code for a feedback issue (#192): derived from the portal id + jobId (jobId is
 * a per-file UUID, so this identifies one result row). Embedded in the issue TITLE as `[code]` so the
 * server can search-before-create and skip duplicates. PRIVACY: it is a one-way hash — neither the
 * portal id nor the jobId can be read back from it (belt-and-suspenders; the receiving repo is private
 * anyway). Not cryptographic — two 32-bit FNV-1a streams combined → ~64-bit space, collision-safe for
 * a per-repo dedup key. Returns '' when either input is empty (→ no dedup, plain title).
 */
export function feedbackDedupCode(portalId: unknown, jobId: unknown): string {
  const p = String(portalId ?? '')
  const j = String(jobId ?? '')
  if (!p || !j) return ''
  const s = `${p}\n${j}`
  let h1 = 0x811c9dc5
  let h2 = 0x243f6a88
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193)
    h2 = Math.imul(h2 ^ c, 0x85ebca6b)
  }
  return ((h1 >>> 0).toString(36) + (h2 >>> 0).toString(36)).slice(0, 10)
}

/**
 * Optional import context attached to the feedback issue so triage can trace it back to a run.
 * PRIVACY: these fields may carry client data (file name, deal id) — they are ONLY rendered because
 * the receiving repo is PRIVATE (see the module header). Every value is stripped + escaped + capped
 * before rendering; unknown/empty fields are omitted.
 */
export interface FeedbackContext {
  jobId?: unknown
  fileName?: unknown
  /** Triage status of the run (#192 п.1): human status + outcome + notes, resolved server-side. */
  status?: unknown
  outcome?: unknown
  notes?: unknown
  entityType?: unknown
  entityId?: unknown
  entityUrl?: unknown
  /** Durable link to the source file on the portal Disk (#192 п.3), attached only with consent. */
  fileUrl?: unknown
  appVersion?: unknown
}

const MAX_CONTEXT_VALUE = 300

/**
 * One `- **Label:** `value`` line, rendered fully INERT. Client-supplied context values (fileName is
 * attacker-influenced — an uploaded document name) must not forge markdown into the issue body:
 *   - collapse interior CR/LF/tab (which `stripHostileChars` intentionally keeps) → a single space,
 *     so a value can't break out of its line and inject extra sections (the body is `join('\n')`d);
 *   - strip backticks, then wrap the value in an inline code span — inside a code span markdown
 *     metacharacters ([](), ![](), *, _, |, #) render literally, so no live links/images/formatting.
 * Empty value → null (omit the line entirely). Cap applied before wrapping.
 */
function contextLine(label: string, value: unknown): string | null {
  const flat = stripHostileChars(value).replace(/[\r\n\t]+/g, ' ').replace(/`/g, '').trim().slice(0, MAX_CONTEXT_VALUE)
  return flat ? `- **${label}:** \`${flat}\`` : null
}

/**
 * Build the { title, body, labels } for the GitHub issue from a validated kind + raw comment +
 * optional import context. The comment is sanitized here (do not assume a pre-sanitized value — this
 * is exported). Body wraps the comment in <pre><code> so backticks/asterisks/HTML are inert. Context
 * lines (status/outcome/notes/jobId/file/entity/version) are rendered ONLY because the receiving repo
 * is private; each is
 * made fully inert (newlines collapsed + wrapped in an inline code span — see contextLine) so a
 * client-supplied value can't inject markdown. Absent/empty context → the section is omitted.
 */
export function buildFeedbackIssue(kind: FeedbackKind, comment: unknown, context: FeedbackContext = {}, dedupCode = ''): IssuePayload {
  const safe = escapeHtml(sanitizeComment(comment)).trim() || '(без текста)'
  const firstLine = safe.split('\n', 1)[0]!.slice(0, 80).trim()
  const kindWord = FEEDBACK_KINDS[kind]
  // Reserve room for the `[code] ` prefix so the dedup marker is never truncated off the 120-char title.
  const prefix = dedupCode ? `[${dedupCode}] ` : ''
  const base = firstLine && firstLine !== '(без текста)'
    ? `${kindWord} · ${firstLine}`
    : `Отзыв сотрудника — ${kindWord}`
  const title = `${prefix}${base}`.slice(0, 120)
  const contextLines = [
    contextLine('Статус разбора', context.status),
    contextLine('Исход', context.outcome),
    contextLine('Замечания', context.notes),
    contextLine('Задача (jobId)', context.jobId),
    contextLine('Файл', context.fileName),
    contextLine('Исходный файл', context.fileUrl),
    contextLine('Сущность', context.entityType),
    contextLine('ID сущности', context.entityId),
    contextLine('Ссылка', context.entityUrl),
    contextLine('Версия приложения', context.appVersion)
  ].filter((l): l is string => l !== null)
  const body = [
    `- **Оценка:** ${kindWord}`,
    '',
    '**Комментарий:**',
    '<pre><code>',
    safe,
    '</code></pre>',
    ...(contextLines.length ? ['', '**Контекст:**', ...contextLines] : [])
  ].join('\n')
  return { title, body, labels: ['user-feedback', `feedback:${kind}`] }
}
