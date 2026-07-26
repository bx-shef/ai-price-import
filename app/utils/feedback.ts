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
/** «Замечания» (triage notes: every warning/error) is the actionable payload of a report — give it a
 *  MUCH larger budget and preserve line breaks, so a 40-line invoice's «товар не найден» list isn't
 *  clipped to the first ~300 chars. */
export const MAX_NOTES_VALUE = 4000

/**
 * One `- **Label:** `value`` context line, rendered fully INERT. Client-supplied context values
 * (fileName is attacker-influenced — an uploaded document name) must not forge markdown into the issue
 * body:
 *   - strip backticks always (so no ``` can escape a code span/fence);
 *   - single-line fields collapse interior CR/LF/tab → one space and wrap in an inline code span;
 *   - a `multiline` field keeps its line breaks and, when it spans lines, renders in a fenced block —
 *     inside code spans/fences markdown metacharacters ([](), *, _, |, #) render literally (no live
 *     links/images/formatting).
 * Empty value → null (omit the line entirely). `cap` applied before wrapping.
 */
function contextLine(label: string, value: unknown, opts: { cap?: number, multiline?: boolean } = {}): string | null {
  const cap = opts.cap ?? MAX_CONTEXT_VALUE
  const noTicks = stripHostileChars(value).replace(/`/g, '')
  if (opts.multiline) {
    const kept = noTicks.replace(/\t/g, ' ').replace(/\r\n?/g, '\n').trim().slice(0, cap)
    if (!kept) return null
    return kept.includes('\n') ? `- **${label}:**\n\`\`\`\n${kept}\n\`\`\`` : `- **${label}:** \`${kept}\``
  }
  const flat = noTicks.replace(/[\r\n\t]+/g, ' ').trim().slice(0, cap)
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
export function buildFeedbackIssue(kind: FeedbackKind, comment: unknown, context: FeedbackContext = {}): IssuePayload {
  const safe = escapeHtml(sanitizeComment(comment)).trim() || '(без текста)'
  const firstLine = safe.split('\n', 1)[0]!.slice(0, 80).trim()
  const kindWord = FEEDBACK_KINDS[kind]
  const title = (firstLine && firstLine !== '(без текста)'
    ? `${kindWord} · ${firstLine}`
    : `Отзыв сотрудника — ${kindWord}`).slice(0, 120)
  const contextLines = [
    contextLine('Статус разбора', context.status),
    contextLine('Исход', context.outcome),
    contextLine('Замечания', context.notes, { cap: MAX_NOTES_VALUE, multiline: true }),
    contextLine('Задача (jobId)', context.jobId),
    contextLine('Файл', context.fileName),
    // #332: the actual source file, committed to the PRIVATE feedback repo (accessible to the
    // publisher) — set only on a successful byte-upload; omitted otherwise.
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

/** Repo-relative path for a source file committed to the PRIVATE feedback repo (#332, byte-upload).
 *  jobId groups files per run; the filename is sanitised to a safe basename (strip directory parts →
 *  no path traversal, allowlist chars, drop leading dots, cap length). Both parts fall back to a
 *  constant so the path is always well-formed. */
export function feedbackFilePath(jobId: string, fileName: string): string {
  const id = String(jobId ?? '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 64) || 'job'
  const base = String(fileName ?? '').split(/[\\/]/).pop() ?? ''
  const safe = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 80) || 'file'
  return `files/${id}/${safe}`
}
