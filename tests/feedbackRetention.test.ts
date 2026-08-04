import { describe, expect, it } from 'vitest'
import { attachedFilePaths, planFeedbackRetention, resolveRetentionMonths, retentionCutoff, runFeedbackRetention, type FeedbackIssueRef } from '../server/utils/feedbackRetention'
import { buildFeedbackIssue } from '../app/utils/feedback'

// #417. Срок хранения отзывов (12 месяцев, п. 8.6 Политики) — обязательство, проверяемое в одно
// действие, поэтому проверяется поведение механизма, а не его наличие.

const NOW = Date.parse('2026-08-04T12:00:00Z')
const issue = (n: number, createdAt: string, body = ''): FeedbackIssueRef => ({ number: n, nodeId: `node-${n}`, createdAt, body })

describe('#417: граница срока', () => {
  it('12 месяцев назад от даты прогона', () => {
    expect(retentionCutoff(NOW, 12).toISOString()).toBe('2025-08-04T12:00:00.000Z')
  })

  it('срок из env: мусор → 12, длиннее 12 не бывает', () => {
    expect(resolveRetentionMonths(undefined)).toBe(12)
    expect(resolveRetentionMonths('нет')).toBe(12)
    expect(resolveRetentionMonths('6')).toBe(6)
    // ⚠ Верхняя граница жёсткая: опечатка не вправе продлить хранение сверх опубликованного срока.
    expect(resolveRetentionMonths('60')).toBe(12)
    expect(resolveRetentionMonths('0')).toBe(12)
  })
})

describe('#417: план чистки', () => {
  it('берёт просроченные и не трогает свежие', () => {
    const plan = planFeedbackRetention([
      issue(1, '2024-01-01T00:00:00Z'),
      issue(2, '2026-07-01T00:00:00Z'),
      issue(3, '2025-01-01T00:00:00Z')
    ], NOW)
    expect(plan.map(p => p.issue.number)).toEqual([1, 3])
  })

  it('самые старые вперёд и кап на прогон', () => {
    const plan = planFeedbackRetention([
      issue(1, '2020-05-01T00:00:00Z'),
      issue(2, '2019-01-01T00:00:00Z'),
      issue(3, '2021-01-01T00:00:00Z')
    ], NOW, 12, 2)
    // Обрезание капом обязано оставлять на потом САМЫЕ СВЕЖИЕ из просроченных.
    expect(plan.map(p => p.issue.number)).toEqual([2, 1])
  })

  it('нечитаемая дата — не стираем', () => {
    // Цена ошибки несимметрична: пропущенный отзыв догонит следующий прогон, стёртый не вернётся.
    expect(planFeedbackRetention([issue(1, 'позавчера'), issue(2, '')], NOW)).toEqual([])
  })
})

describe('#417: пути приложенных файлов', () => {
  it('берутся из ссылки на блоб приёмника', () => {
    const body = '- **Исходный файл:** `https://github.com/o/r/blob/main/files/job-1/scan.pdf`'
    expect(attachedFilePaths(body)).toEqual(['files/job-1/scan.pdf'])
  })

  it('чужие ссылки и обход каталогов игнорируются', () => {
    const body = [
      'https://github.com/o/r/blob/main/README.md',
      'https://github.com/o/r/blob/main/files/../secrets.txt',
      'https://github.com/o/r/blob/main/files/job-2/'
    ].join('\n')
    expect(attachedFilePaths(body)).toEqual([])
  })

  it('путь берётся из настоящей задачи, построенной нашим же билдером', () => {
    // Шов «что пишем» ↔ «что потом ищем»: две стороны одного формата, и разъехавшись, чистка
    // удаляла бы задачи, оставляя документы клиентов в приёмнике навсегда.
    const built = buildFeedbackIssue('down', 'не то', { fileUrl: 'https://github.com/o/r/blob/main/files/abc/накладная.pdf'.replace('накладная', 'nakladnaya') })
    expect(attachedFilePaths(built.body)).toEqual(['files/abc/nakladnaya.pdf'])
  })
})

describe('#417: прогон', () => {
  const deps = (issues: FeedbackIssueRef[] | null, fail: { file?: boolean, issue?: boolean } = {}) => {
    const erased: string[] = []
    const removed: string[] = []
    return {
      erased,
      removed,
      deps: {
        list: async () => issues,
        deleteIssue: async (id: string) => {
          if (fail.issue) return false
          erased.push(id)
          return true
        },
        deleteFile: async (p: string) => {
          if (fail.file) return false
          removed.push(p)
          return true
        },
        now: () => NOW
      }
    }
  }

  it('удаляет файлы и саму задачу', async () => {
    const body = '`https://github.com/o/r/blob/main/files/j/doc.pdf`'
    const t = deps([issue(1, '2024-01-01T00:00:00Z', body)])
    const r = await runFeedbackRetention(t.deps)
    expect(r).toMatchObject({ read: 1, due: 1, erased: 1, files: 1, failed: 0 })
    expect(t.removed).toEqual(['files/j/doc.pdf'])
    expect(t.erased).toEqual(['node-1'])
  })

  it('файл не удалился — задачу не трогаем', async () => {
    // Иначе пропадёт единственная ссылка на документ: он остался бы в приёмнике навсегда и уже
    // без следа, по которому его можно найти.
    const body = '`https://github.com/o/r/blob/main/files/j/doc.pdf`'
    const t = deps([issue(1, '2024-01-01T00:00:00Z', body)], { file: true })
    const r = await runFeedbackRetention(t.deps)
    expect(r).toMatchObject({ erased: 0, failed: 1 })
    expect(t.erased).toEqual([])
  })

  it('приёмник недоступен — не «нечего чистить», а отдельный исход', async () => {
    const r = await runFeedbackRetention(deps(null).deps)
    expect(r.read).toBeNull()
    expect(r.erased).toBe(0)
  })

  it('отказ удаления задачи считается сбоем', async () => {
    const t = deps([issue(1, '2024-01-01T00:00:00Z')], { issue: true })
    expect((await runFeedbackRetention(t.deps)).failed).toBe(1)
  })
})

describe('#417: метка портала для удаления по обращению', () => {
  it('ставится по хэшу портала', () => {
    const p = buildFeedbackIssue('up', 'ок', { portalTag: 'a1b2c3d4e5f6' })
    expect(p.labels).toContain('portal:a1b2c3d4e5f6')
  })

  it('произвольная строка меткой не становится', () => {
    // Метка уходит в адрес запроса при поиске, и это не место для значения из контекста.
    for (const bad of ['', 'not-a-hash', 'A1B2C3D4E5F6', '../../x', 'a1b2c3d4e5f']) {
      expect(buildFeedbackIssue('up', 'ок', { portalTag: bad }).labels.some(l => l.startsWith('portal:'))).toBe(false)
    }
  })

  it('метка — единственное, чем портал опознаётся: сам идентификатор в задачу не идёт', () => {
    const p = buildFeedbackIssue('up', 'ок', { portalTag: 'a1b2c3d4e5f6' })
    expect(p.body).not.toContain('a1b2c3d4e5f6')
  })
})
