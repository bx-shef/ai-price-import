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
 * Build the { title, body, labels } for the GitHub issue from a validated kind + raw comment.
 * The comment is sanitized here (do not assume a pre-sanitized value — this is exported). Body wraps
 * the comment in <pre><code> so backticks/asterisks/HTML are inert. No client context is added by
 * the builder (obезличенно by default); any context the employee typed is their responsibility and
 * the reason the receiving repo must be private.
 */
export function buildFeedbackIssue(kind: FeedbackKind, comment: unknown): IssuePayload {
  const safe = escapeHtml(sanitizeComment(comment)).trim() || '(без текста)'
  const firstLine = safe.split('\n', 1)[0]!.slice(0, 80).trim()
  const kindWord = FEEDBACK_KINDS[kind]
  const title = firstLine && firstLine !== '(без текста)'
    ? `${kindWord} · ${firstLine}`.slice(0, 120)
    : `Отзыв сотрудника — ${kindWord}`.slice(0, 120)
  const body = [
    `- **Оценка:** ${kindWord}`,
    '',
    '**Комментарий:**',
    '<pre><code>',
    safe,
    '</code></pre>'
  ].join('\n')
  return { title, body, labels: ['user-feedback', `feedback:${kind}`] }
}
