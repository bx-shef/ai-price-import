import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MAX_FEEDBACK_BODY_BYTES, feedbackIntakeGate } from '../server/utils/feedbackIntake'
import { MAX_FEEDBACK_FILE_BYTES } from '../app/config/uploadFormats'

const ok = { allowed: true, retryAfterMs: 0 }
const msg = (ms: number) => `подождите ${Math.ceil(ms / 1000)} с`

describe('гейт приёма отзыва', () => {
  it('пропускает обычную отправку', () => {
    expect(feedbackIntakeGate({ rate: ok, declaredLength: 2000, rateMessage: msg })).toBeNull()
  })

  it('превышен лимит частоты → 429 с текстом и retry-after', () => {
    const r = feedbackIntakeGate({ rate: { allowed: false, retryAfterMs: 90_000 }, declaredLength: 10, rateMessage: msg })
    expect(r?.status).toBe(429)
    expect(r?.outcome).toBe('rate_limited')
    expect(r?.retryAfterSec).toBe(90)
    expect(r?.error).toContain('подождите')
  })

  it('слишком большое тело → 413 и БЕЗ retry-after (повтор не поможет)', () => {
    const r = feedbackIntakeGate({ rate: ok, declaredLength: MAX_FEEDBACK_BODY_BYTES + 1, rateMessage: msg })
    expect(r?.status).toBe(413)
    expect(r?.outcome).toBe('bad_request')
    expect(r?.retryAfterSec).toBeUndefined()
    expect(r?.error).toMatch(/без файла/)
  })

  it('лимит частоты проверяется РАНЬШЕ размера — иначе крупным телом можно молотить бесконечно', () => {
    const r = feedbackIntakeGate({
      rate: { allowed: false, retryAfterMs: 1000 },
      declaredLength: MAX_FEEDBACK_BODY_BYTES + 1,
      rateMessage: msg
    })
    expect(r?.status).toBe(429)
  })

  it('отсутствующий content-length не отвергается — иначе сломались бы честные chunked-клиенты', () => {
    expect(feedbackIntakeGate({ rate: ok, declaredLength: 0, rateMessage: msg })).toBeNull()
    expect(feedbackIntakeGate({ rate: ok, declaredLength: Number.NaN, rateMessage: msg })).toBeNull()
  })

  it('кап тела БОЛЬШЕ НЕ связан с размером документа — тело байт не несёт', () => {
    // ⚠ Прежде здесь стояло обратное требование: тело обязано вмещать вложение в base64 (×4/3),
    // и именно оно держало предел документа на 5 МБ — поднять его до 20 МБ значило бы получить
    // ~27 МБ тела против капа 8 МБ, то есть отзыв перестал бы отправляться ВООБЩЕ. С #461 документ
    // читает сервер из вложения дела, связь разорвана, и предел документа поднят до размера
    // импорта. Проверка перевёрнута сознательно: она фиксирует, что связи БОЛЬШЕ НЕТ.
    expect(MAX_FEEDBACK_FILE_BYTES).toBeGreaterThan(MAX_FEEDBACK_BODY_BYTES)
  })
})

describe('роут действительно спрашивает гейт', () => {
  // Мутация ревьюера: закомментированный вызов лимитера в роуте не ронял НИ ОДНОГО теста — лимитер
  // был покрыт в изоляции, а его вызов из роута не проверял никто. Логика вынесена в чистую функцию
  // выше (её поведение под тестом), а здесь сторожим сам факт вызова: без него проверки нет.
  const route = readFileSync(new URL('../server/api/feedback.post.ts', import.meta.url), 'utf8')

  it('гейт вызывается до чтения тела', () => {
    expect(route).toContain('feedbackIntakeGate(')
    expect(route.indexOf('feedbackIntakeGate(')).toBeLessThan(route.indexOf('readBody(event)'))
  })

  it('документ ищется по сотруднику из ПРОВЕРЕННОГО токена, а не по телу запроса (#461)', () => {
    // Несущая проверка приватности на шве роута: `jobId` присылает клиент, и сужение по сотруднику
    // — единственное, что мешает назвать чужое задание своим. Поведение сужения покрыто в
    // `activityFileFetch`, а здесь сторожится сам факт, что роут передаёт туда именно проверенного
    // сотрудника: подмена `member.userId` на что-то из тела не уронила бы ни одного теста.
    expect(route).toContain('fetchActivityFile(jobId, member.userId')
  })

  it('тело запроса байт документа НЕ принимает (#461)', () => {
    // Возврат приёма байт из тела — это возврат прежней дыры: страница снова становится источником
    // документа, а перезагруженная вкладка снова лишает отзыв вложения.
    expect(route).not.toContain('parseClientFile')
    expect(route).not.toContain('raw?.file')
  })

  it('вердикт гейта применяется: статус, заголовок и текст', () => {
    expect(route).toContain('setResponseStatus(event, refusal.status)')
    expect(route).toContain('refusal.retryAfterSec')
    expect(route).toContain('return { error: refusal.error }')
  })

  it('лимитер частоты и длина тела реально подаются в гейт', () => {
    expect(route).toContain('checkFeedbackRate(')
    expect(route).toContain('content-length')
  })
})
