import { describe, expect, it } from 'vitest'
import { isDue, isOwnFeedbackIssue, issueFileDirs, jobIdOf, planFeedbackRetention, portalTagOf, resolveRetentionMonths, retentionCutoff, runFeedbackRetention, type FeedbackIssueRef } from '../server/utils/feedbackRetention'
import { buildFeedbackIssue, feedbackFileDir, feedbackFilePath } from '../app/utils/feedback'

// #417. Срок хранения отзывов (12 месяцев, п. 8.6 Политики) — обязательство, проверяемое в одно
// действие, поэтому проверяется поведение механизма, а не его наличие.

const NOW = Date.parse('2026-08-04T12:00:00Z')
const TAG = 'a1b2c3d4e5f6'

/** Задача-отзыв в том виде, в каком её строит наш же билдер, — иначе проверялся бы вымысел. */
function issue(n: number, createdAt: string, opts: { job?: string, labels?: string[], title?: string } = {}): FeedbackIssueRef {
  const built = buildFeedbackIssue('down', 'не то', { portalTag: TAG, ...(opts.job ? { jobId: opts.job } : {}) })
  return {
    number: n,
    nodeId: `node-${n}`,
    createdAt,
    title: opts.title ?? built.title,
    body: built.body,
    labels: opts.labels ?? built.labels
  }
}

describe('#417: граница срока', () => {
  it('12 месяцев назад от даты прогона', () => {
    expect(retentionCutoff(NOW, 12).toISOString()).toBe('2025-08-04T12:00:00.000Z')
  })

  it('просрочка считается СТРОГО раньше отсечки', () => {
    const cutoff = retentionCutoff(NOW, 12).getTime()
    expect(isDue('2025-08-04T11:59:59Z', cutoff)).toBe(true)
    // Ровно на отсечке — ещё не просрочен: «не более 12 месяцев» истекает по прошествии срока.
    expect(isDue('2025-08-04T12:00:00Z', cutoff)).toBe(false)
    expect(isDue('2025-08-04T12:00:01Z', cutoff)).toBe(false)
  })

  it('нечитаемая дата отсекается ЯВНО, а не побочным свойством NaN', () => {
    // Мутационная проверка показала: снятие `Number.isFinite` не роняло ничего, потому что
    // `NaN < cutoff` и так `false`. Спрашиваем предикат прямо.
    for (const bad of ['позавчера', '', 'null', '2026-13-45']) {
      expect(isDue(bad, retentionCutoff(NOW, 12).getTime()), bad).toBe(false)
    }
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

describe('#417: чужого не трогаем', () => {
  it('нужны метка канала и наш заголовок', () => {
    expect(isOwnFeedbackIssue(issue(1, '2024-01-01T00:00:00Z'))).toBe(true)
    // Опечатка в GITHUB_FEEDBACK_REPO навела бы удаление на публичный репозиторий проекта, где
    // метка `user-feedback` живёт по той же конвенции; заголовок там не совпадёт.
    expect(isOwnFeedbackIssue(issue(3, '2024-01-01T00:00:00Z', { title: 'Баг в парсере' }))).toBe(false)
    expect(isOwnFeedbackIssue(issue(4, '2024-01-01T00:00:00Z', { labels: ['bug'] }))).toBe(false)
  })

  it('задача БЕЗ метки портала — тоже наша', () => {
    // ⚠ Метка появилась вместе с чисткой, а канал работает с 2026-07-19: требование метки
    // исключило бы все накопленные отзывы из чистки НЕ до срока, а навсегда — то есть признак,
    // заведённый ради исполнения срока, сам бы его и нарушил.
    const legacy = issue(9, '2024-01-01T00:00:00Z', { labels: ['user-feedback', 'feedback:down'] })
    expect(isOwnFeedbackIssue(legacy)).toBe(true)
  })

  it('план берёт только просроченные и только свои', () => {
    const plan = planFeedbackRetention([
      issue(1, '2024-01-01T00:00:00Z'),
      issue(2, '2026-07-01T00:00:00Z'),
      issue(3, '2023-01-01T00:00:00Z', { title: 'Чужая задача', labels: ['user-feedback'] }),
      issue(4, '2025-01-01T00:00:00Z')
    ], NOW)
    expect(plan.map(p => p.issue.number)).toEqual([1, 4])
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
})

describe('#417: каталог файлов задачи', () => {
  it('строится из МЕТКИ портала и задания, а не из текста ссылки', () => {
    const i = issue(1, '2024-01-01T00:00:00Z', { job: 'b24-hrbvzq' })
    expect(portalTagOf(i)).toBe(TAG)
    expect(jobIdOf(i.body)).toBe('b24-hrbvzq')
    expect(issueFileDirs(i)).toContain(`files/${TAG}/b24-hrbvzq`)
  })

  it('каталог совпадает с тем, куда файл кладут при приёме отзыва', () => {
    // Шов «куда пишем» ↔ «где потом ищем»: разъехавшись, чистка стирала бы задачи, оставляя
    // документы клиентов в приёмнике навсегда.
    const path = feedbackFilePath(TAG, 'b24-hrbvzq', 'скан.pdf')
    expect(path.startsWith(`${feedbackFileDir(TAG, 'b24-hrbvzq')}/`)).toBe(true)
    expect(issueFileDirs(issue(1, '2024-01-01T00:00:00Z', { job: 'b24-hrbvzq' }))).toContain(feedbackFileDir(TAG, 'b24-hrbvzq'))
  })

  it('каталог привязан к порталу: чужой документ вне досягаемости', () => {
    // Раньше путь был `files/<задание>/…`, а задание приходит от клиента: назвав своим заданием
    // чужое, сотрудник добился бы удаления документа другого портала.
    expect(feedbackFileDir('aaaaaaaaaaaa', 'job1')).not.toBe(feedbackFileDir('bbbbbbbbbbbb', 'job1'))
    // Битый псевдоним не даёт «общего» каталога, куда попали бы все.
    expect(feedbackFileDir('', 'job1')).toBe('files/unknown/job1')
  })

  it('нет задания в теле — каталогов нет (и удалять нечего)', () => {
    expect(issueFileDirs(issue(1, '2024-01-01T00:00:00Z'))).toEqual([])
  })

  it('прежняя раскладка тоже проверяется', () => {
    // До этой задачи файлы клались в `files/<задание>` без портала. Чистка, знающая только новую
    // раскладку, оставила бы уже лежащие документы в приёмнике навсегда.
    const legacy = issue(2, '2024-01-01T00:00:00Z', { job: 'oldjob', labels: ['user-feedback'] })
    expect(issueFileDirs(legacy)).toEqual(['files/oldjob'])
    // У задачи с меткой проверяются ОБА каталога: новый и прежний.
    expect(issueFileDirs(issue(3, '2024-01-01T00:00:00Z', { job: 'j2' }))).toEqual([`files/${TAG}/j2`, 'files/j2'])
  })

  it('идентификатор берётся из секции «Контекст», а не из комментария', () => {
    // Обратные кавычки в комментарии живы (экранируются только & < >), и строка, набранная
    // сотрудником, матчилась раньше настоящей — чистка уходила в другой каталог, стирала задачу и
    // оставляла её документ в приёмнике навсегда, уже без ссылки на себя.
    const forged = buildFeedbackIssue('down', 'Задача (jobId):** `подделка`', { portalTag: TAG, jobId: 'nastoyashchiy' })
    expect(jobIdOf(forged.body)).toBe('nastoyashchiy')
  })

  it('идентификатор из тела санитизируется', () => {
    const body = '**Контекст:**\n- **Задача (jobId):** `../../etc/passwd`'
    expect(jobIdOf(body)).toBe('etcpasswd')
    expect(jobIdOf('**Контекст:**\n- **Задача (jobId):** `!!!`')).toBeNull()
    expect(jobIdOf('- **Задача (jobId):** `abc`')).toBeNull()
  })
})

describe('#417: прогон', () => {
  type Fail = { dir?: boolean, file?: boolean, issue?: boolean, redact?: boolean }
  const harness = (issues: FeedbackIssueRef[] | null, files: string[] = [], fail: Fail = {}) => {
    const erased: string[] = []
    const removed: string[] = []
    const redacted: number[] = []
    return {
      erased,
      removed,
      redacted,
      deps: {
        list: async () => issues,
        // Файлы лежат только в текущей раскладке; прежний каталог пуст — как у нового отзыва.
        listDir: async (dir: string) => (fail.dir ? null : (dir.startsWith(`files/${TAG}/`) ? files.map(f => `${dir}/${f}`) : [])),
        deleteFile: async (p: string) => {
          if (fail.file) return false
          removed.push(p)
          return true
        },
        deleteIssue: async (id: string) => {
          if (fail.issue) return false
          erased.push(id)
          return true
        },
        redactIssue: async (i: FeedbackIssueRef) => {
          if (fail.redact) return false
          redacted.push(i.number)
          return true
        },
        now: () => NOW
      }
    }
  }
  const old = (n = 1) => issue(n, '2024-01-01T00:00:00Z', { job: 'job1' })

  it('удаляет файлы и саму задачу', async () => {
    const t = harness([old()], ['doc.pdf'])
    const r = await runFeedbackRetention(t.deps)
    expect(r).toMatchObject({ read: 1, due: 1, erased: 1, redacted: 0, files: 1, failed: 0 })
    expect(t.removed).toEqual([`files/${TAG}/job1/doc.pdf`])
    expect(t.erased).toEqual(['node-1'])
  })

  it('каталог не прочитан — задачу не трогаем', async () => {
    // Не знаем, лежит ли там документ. Стерев задачу, потеряли бы единственный способ его найти.
    const t = harness([old()], ['doc.pdf'], { dir: true })
    expect(await runFeedbackRetention(t.deps)).toMatchObject({ erased: 0, failed: 1 })
    expect(t.erased).toEqual([])
  })

  it('файл не удалился — задачу не трогаем', async () => {
    const t = harness([old()], ['doc.pdf'], { file: true })
    expect(await runFeedbackRetention(t.deps)).toMatchObject({ erased: 0, failed: 1 })
    expect(t.erased).toEqual([])
  })

  it('нет прав на удаление задачи — обезличиваем, а не залипаем', async () => {
    // Удаление задачи требует админских прав. Без деградации первый прогон удалил бы документы,
    // оставил задачи и на следующие сутки читал бы ровно те же — чистка не сдвинулась бы никогда.
    const t = harness([old()], ['doc.pdf'], { issue: true })
    const r = await runFeedbackRetention(t.deps)
    expect(r).toMatchObject({ erased: 0, redacted: 1, files: 1, failed: 0 })
    expect(t.redacted).toEqual([1])
  })

  it('не вышло ни удалить, ни обезличить — это сбой', async () => {
    const t = harness([old()], [], { issue: true, redact: true })
    expect(await runFeedbackRetention(t.deps)).toMatchObject({ erased: 0, redacted: 0, failed: 1 })
  })

  it('приёмник недоступен — не «нечего чистить», а отдельный исход', async () => {
    const r = await runFeedbackRetention(harness(null).deps)
    expect(r.read).toBeNull()
    expect(r.erased).toBe(0)
  })
})

describe('#417: метка портала для удаления по обращению', () => {
  it('ставится по хэшу портала', () => {
    expect(buildFeedbackIssue('up', 'ок', { portalTag: TAG }).labels).toContain(`portal:${TAG}`)
  })

  it('произвольная строка меткой не становится', () => {
    // Метка уходит в адрес запроса при поиске, и это не место для значения из контекста.
    for (const bad of ['', 'not-a-hash', 'A1B2C3D4E5F6', '../../x', 'a1b2c3d4e5f']) {
      expect(buildFeedbackIssue('up', 'ок', { portalTag: bad }).labels.some(l => l.startsWith('portal:'))).toBe(false)
    }
  })

  it('сам идентификатор портала в задачу не идёт', () => {
    expect(buildFeedbackIssue('up', 'ок', { portalTag: TAG }).body).not.toContain(TAG)
  })
})
