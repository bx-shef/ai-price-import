// Ответ сервера входа → текст для оператора (#271-M). Раньше любой отказ схлопывался в «Не удалось
// войти», и три очень разные ситуации выглядели одинаково: неверный пароль, вход выключен и
// сработавшая защита от перебора.
//
// Чистая функция, без ввода-вывода: сопоставление статуса и текста проверяется тестом.

/**
 * Сколько ждать до следующей попытки, в секундах.
 *
 * Заголовок `Retry-After` есть НЕ всегда: его ставит наш собственный ограничитель, но в основном
 * варианте развёртывания 429 приходит от nginx (`limit_req`), а тот заголовок не шлёт и отвечает
 * HTML вместо JSON. Поэтому нужен запасной срок — и короткий: окно nginx около шести секунд
 * (10 запросов в минуту), и гасить кнопку на минуты из-за него было бы хуже самой проблемы.
 */
export const DEFAULT_RETRY_SEC = 10
/** Дальше этого не ждём: сервер мог прислать что угодно, а вечная блокировка — тупик. */
export const MAX_RETRY_SEC = 300

export function retryAfterSeconds(raw?: number | null): number {
  if (!raw || !Number.isFinite(raw) || raw <= 0) return DEFAULT_RETRY_SEC
  return Math.min(Math.ceil(raw), MAX_RETRY_SEC)
}

/** «через 8 с» / «через 2 минуты» — единица подбирается под величину, а не всегда минуты. */
export function formatWait(seconds: number): string {
  const s = retryAfterSeconds(seconds)
  if (s < 60) return `через ${s} с`
  const m = Math.ceil(s / 60)
  return `через ${m} ${m === 1 ? 'минуту' : m < 5 ? 'минуты' : 'минут'}`
}

export interface LoginFailure {
  /** HTTP-статус ответа. */
  status?: number
  /** Текст ошибки от сервера, если он был. */
  serverMessage?: string
  /** Значение заголовка `Retry-After` в секундах (шлёт только наш ограничитель, не nginx). */
  retryAfterSec?: number | null
}

/**
 * Текст под формой входа. Статус важнее текста сервера: сообщение может измениться, а смысл кода —
 * нет. Ответ сервера берём только там, где он несёт что-то сверх кода.
 */
export function loginErrorMessage(f: LoginFailure): string {
  switch (f.status) {
    case 401:
      return 'Неверный пароль.'
    case 429:
      return `Слишком много попыток входа. Попробуйте ${formatWait(retryAfterSeconds(f.retryAfterSec))}.`
    case 503:
      // Отличается от спокойной формулировки в предупреждении наверху: там объясняют состояние,
      // здесь — сорванное действие, и одинаковый текст в двух разных по тону блоках сбивал бы.
      return 'Вход выключен: пароль оператора не задан на сервере.'
    default:
      // Сеть недоступна, прокси отдал 502 и прочее «не наше» — не выдумываем причину.
      return f.serverMessage?.trim() || 'Не удалось войти. Проверьте соединение и попробуйте снова.'
  }
}

/**
 * Временная ли блокировка (защита от перебора). Именно временная: снимается сама по таймеру,
 * поэтому гасим только кнопку отправки — поле остаётся живым, фокус из него не выпадает, и человек
 * не остаётся на странице, где нечего нажать и некуда перейти с клавиатуры.
 */
export function isThrottled(status?: number): boolean {
  return status === 429
}

/** Терминальная блокировка: пока администратор не задаст пароль, входить нечем. */
export function isDisabledByServer(status?: number): boolean {
  return status === 503
}

/** Статус ошибки запроса: у разных транспортов он лежит в разных полях. */
export function failureStatus(err: unknown): number | undefined {
  const e = err as { statusCode?: number, status?: number, response?: { status?: number } } | undefined
  return e?.statusCode ?? e?.status ?? e?.response?.status
}
