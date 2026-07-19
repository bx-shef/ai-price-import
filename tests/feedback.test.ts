import { describe, expect, it } from 'vitest'
import { buildFeedbackIssue, escapeHtml, feedbackDedupCode, MAX_COMMENT_LENGTH, normalizeKind, sanitizeComment, stripHostileChars } from '../app/utils/feedback'

// Build hostile chars from code points (never type the invisible characters literally — that would
// itself be a Trojan-Source vector, and the point of the strip is to remove exactly these).
const ZWSP = String.fromCharCode(0x200b)
const BIDI = String.fromCharCode(0x202e) // RTL override
const BOM = String.fromCharCode(0xfeff)
const NUL = String.fromCharCode(0x00)
const WJ = String.fromCharCode(0x2060) // WORD JOINER (invisible)

describe('feedback — sanitization', () => {
  it('stripHostileChars removes zero-width / bidi / BOM / controls but keeps tab+newline', () => {
    expect(stripHostileChars(`a${ZWSP}b${BIDI}c${BOM}d${NUL}e${WJ}f`)).toBe('abcdef')
    expect(stripHostileChars('a\tb\nc')).toBe('a\tb\nc')
  })
  it('sanitizeComment caps content at the max + adds a truncation marker', () => {
    const long = 'x'.repeat(MAX_COMMENT_LENGTH * 2)
    const out = sanitizeComment(long)
    expect(out.length).toBeLessThan(long.length)
    expect(out.startsWith('x'.repeat(MAX_COMMENT_LENGTH))).toBe(true) // exactly the cap of content
    expect(out).toContain('[truncated to')
    // a comment at/under the cap is returned unchanged (no marker)
    expect(sanitizeComment('x'.repeat(MAX_COMMENT_LENGTH))).not.toContain('[truncated')
  })
  it('escapeHtml makes markup inert', () => {
    expect(escapeHtml('<b>&</b>')).toBe('&lt;b&gt;&amp;&lt;/b&gt;')
  })
})

describe('feedback — normalizeKind', () => {
  it('accepts only up/down', () => {
    expect(normalizeKind('up')).toBe('up')
    expect(normalizeKind('down')).toBe('down')
    expect(normalizeKind('idea')).toBeNull()
    expect(normalizeKind(undefined)).toBeNull()
  })
})

describe('feedback — feedbackDedupCode', () => {
  it('is deterministic and short (≤10 alnum chars)', () => {
    const a = feedbackDedupCode('member-1', 'job-abc')
    expect(a).toBe(feedbackDedupCode('member-1', 'job-abc')) // stable
    expect(a).toMatch(/^[a-z0-9]{1,10}$/)
  })
  it('differs for different portal or jobId', () => {
    expect(feedbackDedupCode('m1', 'job-abc')).not.toBe(feedbackDedupCode('m2', 'job-abc'))
    expect(feedbackDedupCode('m1', 'job-a')).not.toBe(feedbackDedupCode('m1', 'job-b'))
  })
  it('empty when either input is missing (→ no dedup)', () => {
    expect(feedbackDedupCode('', 'job')).toBe('')
    expect(feedbackDedupCode('m', '')).toBe('')
    expect(feedbackDedupCode(null, undefined)).toBe('')
  })
  it('leaks neither the portal id nor the jobId (one-way)', () => {
    const code = feedbackDedupCode('bel.bitrix24.by', 'job-secret-123')
    expect(code).not.toContain('bel')
    expect(code).not.toContain('secret')
    expect(code).not.toContain('123')
  })
})

describe('feedback — buildFeedbackIssue', () => {
  it('prefixes the title with [dedupCode] when given, within the 120-char cap', () => {
    const p = buildFeedbackIssue('down', 'плохо', {}, 'abc123')
    expect(p.title.startsWith('[abc123] ')).toBe(true)
    expect(p.title.length).toBeLessThanOrEqual(120)
    // no code → no prefix
    expect(buildFeedbackIssue('down', 'плохо').title.startsWith('[')).toBe(false)
  })
  it('builds title/body/labels; comment rendered inert inside <pre><code>', () => {
    const p = buildFeedbackIssue('down', 'сделка <script> не создалась')
    expect(p.labels).toEqual(['user-feedback', 'feedback:down'])
    expect(p.title).toContain('отрицательный')
    expect(p.body).toContain('<pre><code>')
    // HTML in the comment is escaped, not live.
    expect(p.body).toContain('&lt;script&gt;')
    expect(p.body).not.toContain('<script>')
  })
  it('empty comment → «(без текста)» and a generic title', () => {
    const p = buildFeedbackIssue('up', '   ')
    expect(p.body).toContain('(без текста)')
    expect(p.title).toContain('Отзыв сотрудника')
  })
  it('strips hostile chars from the comment before building', () => {
    const p = buildFeedbackIssue('up', `хоро${ZWSP}шо`)
    expect(p.body).toContain('хорошо')
  })
  it('renders a Контекст section from provided fields (jobId/file/entity), inert', () => {
    const p = buildFeedbackIssue('down', 'плохо', {
      jobId: 'job-42',
      fileName: `на${ZWSP}кладная.xlsx`,
      entityType: 'Сделка',
      entityId: 33,
      entityUrl: 'https://bel.bitrix24.by/crm/deal/details/33/'
    })
    expect(p.body).toContain('**Контекст:**')
    expect(p.body).toContain('job-42')
    expect(p.body).toContain('накладная.xlsx') // hostile char stripped
    expect(p.body).toContain('Сделка')
    expect(p.body).toContain('33')
  })
  it('renders context values inert inside an inline code span (no live markdown/HTML)', () => {
    const p = buildFeedbackIssue('up', 'ok', { fileName: '<img src=x>' })
    // Inside a code span `<img src=x>` is literal text, not a live tag, and not a markdown link.
    expect(p.body).toContain('- **Файл:** `<img src=x>`')
  })
  it('neutralizes newline + markdown-link injection in a context value (no forged sections)', () => {
    // A hostile fileName tries to break out of its line and forge a new heading + a live link.
    const p = buildFeedbackIssue('up', 'ok', {
      fileName: 'ok\n\n**Комментарий:**\nspoofed [click](https://evil.example)'
    })
    // The value stays on ONE line (newlines collapsed) wrapped in a code span → whole payload inert.
    const lines = p.body.split('\n').filter(l => l.startsWith('- **Файл:**'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toBe('- **Файл:** `ok **Комментарий:** spoofed [click](https://evil.example)`')
    // exactly one REAL Комментарий heading — the forged one is now literal text inside backticks
    expect(p.body.match(/^\*\*Комментарий:\*\*$/gm)).toHaveLength(1)
  })
  it('renders the разбор block (status/outcome/notes) and the source-file link (#192 п.1/п.3), inert', () => {
    const p = buildFeedbackIssue('down', 'плохо', {
      status: 'Готово',
      outcome: 'Сущность создана',
      notes: 'Поставщик не найден; Валюта XXX отсутствует',
      fileUrl: 'https://bel.bitrix24.by/docs/file/123/'
    })
    expect(p.body).toContain('- **Статус разбора:** `Готово`')
    expect(p.body).toContain('- **Исход:** `Сущность создана`')
    expect(p.body).toContain('- **Замечания:** `Поставщик не найден; Валюта XXX отсутствует`')
    expect(p.body).toContain('- **Исходный файл:** `https://bel.bitrix24.by/docs/file/123/`')
  })
  it('omits the Контекст section entirely when no context is given', () => {
    expect(buildFeedbackIssue('up', 'ok').body).not.toContain('**Контекст:**')
    expect(buildFeedbackIssue('up', 'ok', {}).body).not.toContain('**Контекст:**')
  })
})
