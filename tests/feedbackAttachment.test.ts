import { describe, it, expect, vi } from 'vitest'
import { resolveFeedbackAttachment, type AttachmentDeps } from '../server/utils/feedbackAttachment'

// #461, разбор тестировщика. Прежде эта ветка жила в `defineEventHandler` и сторожилась грепом по
// исходнику. Греп ловит удаление строки и НЕ ловит подмену значения: одна строка
// `member.userId = raw.context.userId ?? member.userId` перед вызовом оставляла бы литерал на месте,
// проходила бы гард и открывала доступ к документу ЧУЖОГО сотрудника. Здесь проверяется поведение.

const BYTES = new Uint8Array([37, 80, 68, 70])
const URL_OK = 'https://b24-hrbvzq.bitrix24.by/rest/download.json?token=x'

function deps(over: Partial<AttachmentDeps> = {}): AttachmentDeps {
  return {
    resolveCall: async () => vi.fn(async (method: string) => method === 'crm.activity.list'
      ? [{ ID: '7' }]
      : { FILES: [{ url: URL_OK, name: 'счёт.pdf' }] }),
    uploadAllowed: async () => true,
    checkBudget: async () => ({ allowed: true, notice: '' }),
    commit: async () => 'https://github.com/owner/repo/blob/main/f.pdf',
    download: async () => ({ status: 200, contentType: 'application/pdf', bytes: BYTES }),
    originatorCode: 'SH_APP_IMPORT_PRICE_AI',
    maxBytes: 20 * 1024 * 1024,
    missingNotice: 'Отзыв отправлен, но документ приложить не удалось.',
    ...over
  }
}

describe('#461: вложение к отзыву', () => {
  it('счастливый путь: документ прочитан, положен в приёмник, оговорки нет', async () => {
    expect(await resolveFeedbackAttachment('job-1', 17, deps()))
      .toEqual({ fileUrl: 'https://github.com/owner/repo/blob/main/f.pdf' })
  })

  it('в портал уходит ИМЕННО тот сотрудник, которого передали — и никакой другой', async () => {
    // Несущая проверка приватности. Подмена источника `userId` (например, на поле из тела запроса)
    // здесь краснеет, а грепу по исходнику была не видна.
    const call = vi.fn(async (m: string) => m === 'crm.activity.list' ? [] : null)
    await resolveFeedbackAttachment('job-1', 17, deps({ resolveCall: async () => call }))
    const [, params] = call.mock.calls[0] as unknown as [string, { filter: Record<string, string> }]
    expect(params.filter.RESPONSIBLE_ID).toBe('17')
    expect(params.filter.ORIGIN_ID).toBe('job-1')
  })

  it('КЛАСС промаха отдаётся наружу — им решается судьба второго источника (#506 п.3)', async () => {
    // ⚠ Несущее различение. «Дела нет вовсе» и «дело есть, но прочитать не вышло» — разные исходы, и
    // только у первого законны байты из тела запроса. Пока промах был виден лишь как «нет ссылки»,
    // роут не мог их различить, и заявленная граница существовала только в комментарии.
    const noActivity = await resolveFeedbackAttachment('job-1', 17, deps({
      resolveCall: async () => vi.fn(async () => [])
    }))
    expect(noActivity.miss, 'дела в портале не нашлось').toBe('no-activity')

    const brokenDownload = await resolveFeedbackAttachment('job-1', 17, deps({
      download: async () => ({ status: 500, contentType: 'application/pdf', bytes: new Uint8Array() })
    }))
    expect(brokenDownload.miss, 'дело ЕСТЬ, сорвалось скачивание').not.toBe('no-activity')

    const noPrivacy = await resolveFeedbackAttachment('job-1', 17, deps({ uploadAllowed: async () => false }))
    expect(noPrivacy.miss, 'про дело мы ничего не узнали').not.toBe('no-activity')

    const budget = await resolveFeedbackAttachment('job-1', 17, deps({
      checkBudget: async () => ({ allowed: false, notice: 'предел' })
    }))
    expect(budget.miss, 'предел исчерпан — обходить его вторым путём нельзя').not.toBe('no-activity')
  })

  it('предел приёмника тратится ПОСЛЕ чтения документа, а не до', async () => {
    // ⚠ Обратный порядок мерил бы НАМЕРЕНИЕ вместо расхода: шестьдесят запросов «с файлом», у
    // которых документа нет вовсе, выключали бы вложения всем клиентам, ничего не стоив
    // отправителю. Перестановка двух строк роняет этот тест.
    const order: string[] = []
    await resolveFeedbackAttachment('job-1', 17, deps({
      download: async () => {
        order.push('download')
        return { status: 200, contentType: 'application/pdf', bytes: BYTES }
      },
      checkBudget: async () => {
        order.push('budget')
        return { allowed: true, notice: '' }
      }
    }))
    expect(order).toEqual(['download', 'budget'])
  })

  it('документа нет → бюджет НЕ тратится, а человеку говорят', async () => {
    const checkBudget = vi.fn(async () => ({ allowed: true, notice: '' }))
    const r = await resolveFeedbackAttachment('job-1', 17, deps({
      resolveCall: async () => vi.fn(async () => []),
      checkBudget
    }))
    expect(r.fileUrl).toBeUndefined()
    expect(r.notice).toContain('приложить не удалось')
    expect(checkBudget).not.toHaveBeenCalled()
  })

  it('предел исчерпан → своя оговорка, а не общая', async () => {
    // Причины разные, и текст разный: «слишком часто» лечится ожиданием, «не нашли» — нет.
    const r = await resolveFeedbackAttachment('job-1', 17, deps({
      checkBudget: async () => ({ allowed: false, notice: 'Сейчас много отзывов, документ не приложен.' })
    }))
    expect(r.notice).toBe('Сейчас много отзывов, документ не приложен.')
  })

  it('приёмник не подтверждён приватным → байты НЕ читаются вовсе', async () => {
    // #200: слаг репозитория берётся из переменной окружения, и одна опечатка публиковала бы
    // реальные счета клиентов. Проверка обязана стоять ДО чтения документа.
    const download = vi.fn()
    const r = await resolveFeedbackAttachment('job-1', 17, deps({
      uploadAllowed: async () => false,
      download: download as unknown as AttachmentDeps['download']
    }))
    expect(download).not.toHaveBeenCalled()
    expect(r.notice).toContain('приложить не удалось')
  })

  it('приложение не установлено (нет токена портала) → оговорка, без падения', async () => {
    const r = await resolveFeedbackAttachment('job-1', 17, deps({ resolveCall: async () => null }))
    expect(r.notice).toContain('приложить не удалось')
  })

  it('приёмник не принял файл → молчания нет, оговорка есть', async () => {
    const r = await resolveFeedbackAttachment('job-1', 17, deps({ commit: async () => null }))
    expect(r.fileUrl).toBeUndefined()
    expect(r.notice).toContain('приложить не удалось')
  })

  it('любая авария внутри НЕ ломает отправку отзыва', async () => {
    // Отзыв ценнее вложения: текст всё равно должен доехать.
    for (const boom of [
      deps({ resolveCall: async () => { throw new Error('нет базы') } }),
      deps({ uploadAllowed: async () => { throw new Error('GitHub') } }),
      deps({ commit: async () => { throw new Error('сеть') } })
    ]) {
      const r = await resolveFeedbackAttachment('job-1', 17, boom)
      expect(r.notice).toContain('приложить не удалось')
    }
  })

  it('класс промаха уходит в журнал — иначе деградация немая', async () => {
    const logMiss = vi.fn()
    await resolveFeedbackAttachment('job-1', 17, deps({
      resolveCall: async () => vi.fn(async () => []),
      logMiss
    }))
    expect(logMiss).toHaveBeenCalledWith('no-activity')
  })
})
