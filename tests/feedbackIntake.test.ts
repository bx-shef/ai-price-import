import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MAX_FEEDBACK_BODY_BYTES, feedbackIntakeGate, parseClientFile } from '../server/utils/feedbackIntake'
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

  it('кап тела с запасом покрывает вложение в base64 (×4/3) плюс сам отзыв', () => {
    expect(MAX_FEEDBACK_BODY_BYTES).toBeGreaterThan(Math.ceil((MAX_FEEDBACK_FILE_BYTES * 4) / 3))
  })
})

describe('parseClientFile — единственная серверная проверка присланных байт', () => {
  const b64 = (bytes: number) => 'A'.repeat(Math.floor((bytes * 4) / 3 / 4) * 4)

  it('принимает нормальное вложение и имя', () => {
    expect(parseClientFile({ name: 'счёт.pdf', base64: 'AQID' })).toEqual({ name: 'счёт.pdf', base64: 'AQID' })
  })

  it('без имени принимает файл, но имя пустое — путь достроит feedbackFilePath', () => {
    expect(parseClientFile({ base64: 'AQID' })?.name).toBe('')
    expect(parseClientFile({ name: 42, base64: 'AQID' })?.name).toBe('')
  })

  it('не-base64 отвергается целиком, а не сохраняется мусором', () => {
    for (const bad of ['не base64', 'AQ ID', 'AQ<ID>', 'АQID', 'AQID===']) {
      expect(parseClientFile({ base64: bad }), bad).toBeNull()
    }
  })

  it('превышение капа файла → null (отзыв уходит без вложения, а не падает)', () => {
    expect(parseClientFile({ base64: b64(MAX_FEEDBACK_FILE_BYTES + 1024) })).toBeNull()
    expect(parseClientFile({ base64: b64(MAX_FEEDBACK_FILE_BYTES - 1024) })).not.toBeNull()
  })

  it('мусорная форма не роняет разбор', () => {
    for (const junk of [null, undefined, 'строка', 42, [], {}, { base64: '' }, { base64: 123 }]) {
      expect(parseClientFile(junk)).toBeNull()
    }
  })

  it('регулярка base64 не даёт катастрофического отката (длинная строка + плохой хвост)', () => {
    const started = performance.now()
    expect(parseClientFile({ base64: `${'A'.repeat(1_000_000)}!` })).toBeNull()
    expect(performance.now() - started).toBeLessThan(1000)
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
