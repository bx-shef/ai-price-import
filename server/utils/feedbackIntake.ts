// Intake gate for POST /api/feedback — everything the route decides BEFORE it does any work, as a
// pure function (#351 review).
//
// Why it lives here and not inline in the handler: a reviewer's mutation showed that commenting out
// the rate-limit call in the route left the whole test suite green — the limiter had unit tests, but
// nothing asserted the ROUTE consults it. A Nitro handler is awkward to unit-test, so the decision
// moves out into a function that can be, and the handler keeps only the I/O around it.
//
// The gate exists because the route stopped being cheap: since #349 the source document rides WITH
// the rating, so one authenticated employee can loop «issue + 5 MB commit» and burn the publisher's
// GitHub quota. Rate first, then size — both before the body is read.

/**
 * Cap on the whole JSON body: comment + context.
 *
 * ⚠ Байт документа тело БОЛЬШЕ НЕ НЕСЁТ (#461) — сервер читает его из вложения дела, — поэтому
 * предел давно перестал быть узким местом и остаётся обычной защитой от раздутого запроса.
 * Текст отказа при этом продолжает советовать «отправьте без файла»: другого способа получить
 * такое тело у сотрудника нет, а совет остаётся исполнимым.
 */
export const MAX_FEEDBACK_BODY_BYTES = 8 * 1024 * 1024

export interface IntakeRefusal {
  status: 413 | 429
  /** Value for the OTel span's `http.outcome`. */
  outcome: 'rate_limited' | 'bad_request'
  /** Text shown to the employee — says what to do, not just that they were refused. */
  error: string
  /** Seconds for the `retry-after` header; absent for a size refusal (retrying won't help). */
  retryAfterSec?: number
}

export interface IntakeInput {
  /** Decision from the per-employee limiter (already counted). */
  rate: { allowed: boolean, retryAfterMs: number }
  /** Declared `content-length`, or 0/NaN when the header is absent. */
  declaredLength: number
  /** Message builder for the rate refusal (injected so this core stays free of formatting deps). */
  rateMessage: (retryAfterMs: number) => string
}

/**
 * Decide whether to accept this submission. Returns the refusal, or null to proceed.
 *
 * NB on the size check: it reads the DECLARED length, so it bounds an honest client's body before it
 * is materialised. A client that omits or understates `content-length` is not stopped here — that is
 * what the global edge guard and the per-employee rate limit are for. Rejecting a missing header
 * outright would break legitimate chunked clients for no real gain.
 */
export function feedbackIntakeGate(input: IntakeInput): IntakeRefusal | null {
  if (!input.rate.allowed) {
    return {
      status: 429,
      outcome: 'rate_limited',
      error: input.rateMessage(input.rate.retryAfterMs),
      retryAfterSec: Math.ceil(input.rate.retryAfterMs / 1000)
    }
  }
  const declared = input.declaredLength
  if (Number.isFinite(declared) && declared > MAX_FEEDBACK_BODY_BYTES) {
    return {
      status: 413,
      outcome: 'bad_request',
      error: 'Отзыв слишком большой. Отправьте его без файла.'
    }
  }
  return null
}
