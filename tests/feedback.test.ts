import { describe, expect, it } from 'vitest'
import { buildFeedbackIssue, escapeHtml, feedbackFilePath, MAX_COMMENT_LENGTH, normalizeKind, sanitizeComment, stripHostileChars } from '../app/utils/feedback'

describe('feedbackFilePath (#332 byte-upload repo path)', () => {
  const TAG = 'a1b2c3d4e5f6'
  it('builds files/<портал>/<jobId>/<safe basename>', () => {
    expect(feedbackFilePath(TAG, 'job-1', 'invoice.pdf')).toBe(`files/${TAG}/job-1/invoice.pdf`)
  })
  it('strips directory parts (no traversal) + unsafe chars', () => {
    expect(feedbackFilePath(TAG, 'j1', '../../etc/passwd')).toBe(`files/${TAG}/j1/passwd`)
    expect(feedbackFilePath(TAG, 'j1', 'a b/c<>d.xlsx')).toBe(`files/${TAG}/j1/c__d.xlsx`)
    expect(feedbackFilePath(TAG, 'j1', '..hidden')).toBe(`files/${TAG}/j1/hidden`)
  })
  it('sanitises the jobId and falls back when parts empty', () => {
    expect(feedbackFilePath(TAG, 'a/b!', '')).toBe(`files/${TAG}/ab/file`)
    expect(feedbackFilePath(TAG, '', '')).toBe(`files/${TAG}/job/file`)
  })
  it('битый псевдоним портала не даёт общего каталога (#417)', () => {
    // Иначе документы разных клиентов легли бы в один каталог, и чистка одного задела бы чужие.
    expect(feedbackFilePath('', 'j1', 'a.pdf')).toBe('files/unknown/j1/a.pdf')
    expect(feedbackFilePath('../../x', 'j1', 'a.pdf')).toBe('files/unknown/j1/a.pdf')
  })
  it('caps the jobId (64) and basename (80)', () => {
    const p = feedbackFilePath(TAG, 'j'.repeat(100), `${'n'.repeat(100)}.pdf`)
    const [, , id, name] = p.split('/')
    expect(id!.length).toBe(64)
    expect(name!.length).toBe(80)
  })
})

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

describe('feedback — buildFeedbackIssue', () => {
  it('builds title/body/labels; comment rendered inert inside <pre><code>', () => {
    const p = buildFeedbackIssue('down', 'сделка <script> не создалась')
    expect(p.labels).toEqual(['user-feedback', 'feedback:down'])
    // #299: заголовок ОДИН на обе оценки, различает их только метка; словами оценка идёт в теле.
    expect(p.title).toBe('[🔴] Отзыв сотрудника')
    expect(p.body).toContain('отрицательный')
    expect(p.body).toContain('<pre><code>')
    // HTML in the comment is escaped, not live.
    expect(p.body).toContain('&lt;script&gt;')
    expect(p.body).not.toContain('<script>')
  })
  it('empty comment → «(без текста)» and a generic title', () => {
    const p = buildFeedbackIssue('up', '   ')
    expect(p.body).toContain('(без текста)')
    expect(p.title).toBe('[🟢] Отзыв сотрудника')
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
  it('«Замечания»: keeps the FULL multi-line notes (big cap) in a fenced block, inert', () => {
    const notes = Array.from({ length: 40 }, (_, i) => `Товар «позиция ${i}» не найден — строка пропущена`).join('\n')
    expect(notes.length).toBeGreaterThan(300) // would be clipped by the old 300-char cap
    const p = buildFeedbackIssue('down', 'плохо', { notes })
    expect(p.body).toContain('Товар «позиция 0» не найден')
    expect(p.body).toContain('Товар «позиция 39» не найден') // the LAST one survives (not clipped)
    expect(p.body).toContain('- **Замечания:**\n```\n') // multi-line → fenced block
  })
  it('omits the Контекст section entirely when no context is given', () => {
    expect(buildFeedbackIssue('up', 'ok').body).not.toContain('**Контекст:**')
    expect(buildFeedbackIssue('up', 'ok', {}).body).not.toContain('**Контекст:**')
  })
})

describe('заголовок отзыва — один на обе оценки (#299)', () => {
  it('различает оценки только меткой, текст комментария в заголовок не выносит', () => {
    const up = buildFeedbackIssue('up', 'товар не тот')
    const down = buildFeedbackIssue('down', 'товар не тот')
    expect(up.title).toBe('[🟢] Отзыв сотрудника')
    expect(down.title).toBe('[🔴] Отзыв сотрудника')
    expect(up.title).not.toContain('товар не тот')
    // Оценка машинно-читаема по метке задачи — на неё опирается разбор.
    expect(up.labels).toContain('feedback:up')
    expect(down.labels).toContain('feedback:down')
  })
})
