import { describe, expect, it } from 'vitest'
import { STALE_DAYS, buildDigestText, isoWeekKey, summarizeFeedbackIssues } from '../server/utils/feedbackDigest'
import type { FeedbackIssueRef } from '../server/utils/feedbackRetention'

const NOW = Date.parse('2026-08-08T12:00:00Z')
const daysAgo = (n: number) => new Date(NOW - n * 24 * 3600 * 1000).toISOString()

const issue = (over: Partial<FeedbackIssueRef> = {}): FeedbackIssueRef => ({
  number: 1,
  nodeId: 'n1',
  createdAt: daysAgo(1),
  title: '[🔴] Отзыв сотрудника',
  body: 'текст',
  labels: ['user-feedback', 'feedback:down'],
  ...over
})

describe('свод открытых отзывов', () => {
  it('считает оценки по МЕТКАМ, а не по заголовку', () => {
    // Заголовок несёт цветной кружок и переживает любую косметическую правку текста; метку ставит
    // тот же билдер, что и заводит задачу.
    const s = summarizeFeedbackIssues([
      issue({ labels: ['user-feedback', 'feedback:up'], title: 'что угодно' }),
      issue({ labels: ['user-feedback', 'feedback:down'], title: 'что угодно' })
    ], NOW)
    expect(s.up).toBe(1)
    expect(s.down).toBe(1)
    expect(s.open).toBe(2)
  })

  it('задача без нашей оценки считается открытой, но стороны ей не выдумывают', () => {
    const s = summarizeFeedbackIssues([issue({ labels: ['user-feedback'] })], NOW)
    expect(s.open).toBe(1)
    expect(s.up + s.down).toBe(0)
  })

  it('документ считается по метке билдера в теле', () => {
    const s = summarizeFeedbackIssues([
      issue({ body: '- **Исходный файл:** `ссылка`' }),
      issue({ body: 'без файла' })
    ], NOW)
    expect(s.withFile).toBe(1)
  })

  it('запущенные и возраст самого старого', () => {
    const s = summarizeFeedbackIssues([
      issue({ createdAt: daysAgo(40) }),
      issue({ createdAt: daysAgo(STALE_DAYS) }),
      issue({ createdAt: daysAgo(2) })
    ], NOW)
    expect(s.stale).toBe(2)
    expect(s.oldestDays).toBe(40)
    expect(s.lastWeek).toBe(1)
  })

  it('непрочитанная дата не старит и не омолаживает', () => {
    // Дата приходит от GitHub строкой; битая не должна ни поднять тревогу, ни погасить её.
    const s = summarizeFeedbackIssues([issue({ createdAt: 'мусор' })], NOW)
    expect(s.open).toBe(1)
    expect(s.stale).toBe(0)
    expect(s.oldestDays).toBeNull()
  })
})

describe('текст сводки', () => {
  it('«приёмник не прочитан» — ОТДЕЛЬНЫЙ текст, а не нули', () => {
    // Несущее утверждение всей задачи: авария канала не должна выглядеть спокойной неделей.
    const t = buildDigestText(null)
    expect(t).toMatch(/не прочитан/)
    expect(t).toMatch(/НЕ значит, что отзывов нет/)
  })

  it('пусто — так и сказано', () => {
    expect(buildDigestText(summarizeFeedbackIssues([], NOW))).toMatch(/неразобранных нет/)
  })

  it('в тексте есть счётчики и предупреждение о запущенных', () => {
    const t = buildDigestText(summarizeFeedbackIssues([
      issue({ createdAt: daysAgo(30), body: '- **Исходный файл:** `x`' }),
      issue({ labels: ['user-feedback', 'feedback:up'] })
    ], NOW))
    expect(t).toContain('2')
    expect(t).toMatch(/Лежат дольше 14 суток: 1/)
  })

  it('данных клиента в тексте нет ни при каких полях', () => {
    // Приёмник приватен именно потому, что тело отзыва содержит документ клиента; сводка уходит в
    // мессенджер, то есть за тот же периметр.
    const t = buildDigestText(summarizeFeedbackIssues([
      issue({ title: 'ООО «Ромашка» накладная', body: 'jobId abc-123, файл scan.pdf, комментарий клиента' })
    ], NOW))
    expect(t).not.toMatch(/Ромашка|abc-123|scan\.pdf|комментарий клиента/)
  })
})

describe('ключ недели', () => {
  it('стабилен внутри недели и меняется на её границе', () => {
    // Ключ обязан зависеть только от календаря: «неделя от старта процесса» при выкатах по
    // десятку в день не наступила бы никогда.
    const mon = new Date('2026-08-03T00:00:00Z')
    const sun = new Date('2026-08-09T23:59:00Z')
    const next = new Date('2026-08-10T00:01:00Z')
    expect(isoWeekKey(mon)).toBe(isoWeekKey(sun))
    expect(isoWeekKey(next)).not.toBe(isoWeekKey(mon))
  })

  it('на стыке годов номер недели не сбрасывается посреди недели', () => {
    expect(isoWeekKey(new Date('2026-12-31T00:00:00Z'))).toBe(isoWeekKey(new Date('2027-01-01T00:00:00Z')))
  })
})
