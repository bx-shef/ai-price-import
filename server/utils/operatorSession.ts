import { timingSafeEqual } from 'node:crypto'
import { resolveAuthConfig, verifySession } from './session'

// Shared operator-session constants + guard used by the auth routes and any
// operator-only endpoint (e.g. /api/ops/queues). Cookie is HttpOnly/SameSite=Lax/Secure.

// ⚠ Смена имени разлогинивает открытую консоль ровно один раз; клиентов она не касается —
// это служебный вход владельца (#412).
// ⚠ Смена имени куки разлогинивает открытую консоль владельца (одну, свою — клиентов это не
// касается). Прежняя кука `procure_op` при этом НЕ удаляется: выход сносит только текущее имя, и
// старая висит в браузере до истечения срока. Безвредно, но это забытое состояние, а не «вышли».
export const OP_COOKIE = 'ai_price_import_op'
export const OP_MAX_AGE_MS = 8 * 60 * 60 * 1000 // 8 hours
export const OP_MAX_AGE_S = OP_MAX_AGE_MS / 1000

/** True when the cookie carries a valid, in-window operator session. */
export function operatorAllowed(cookie: string | undefined, env: Record<string, string | undefined>, now: number): boolean {
  const cfg = resolveAuthConfig(env)
  return verifySession(cookie ?? '', cfg.secret, now, OP_MAX_AGE_MS).valid
}

/** Constant-time app-token check for /api/queues (X-Check-Token). Fail-closed when
 * the expected token is unset — an empty provided header must NOT compare equal. */
/**
 * Ожидаемый токен служебного роута `/api/queues`.
 *
 * ⚠ Читается ТОЛЬКО `OPS_CHECK_TOKEN`. Раньше роут брал `B24_APPLICATION_TOKEN` — переменную, у
 * которой есть второй, несвязанный смысл в установке приложения; заполнив её ради мониторинга,
 * администратор ломал установку клиентам. Возврат к ней — мутация, которую до этой функции не
 * ловил ни один тест: роут не был покрыт вовсе.
 * ⚠ Пусто ⇒ роут закрыт (`opsTokenOk` fail-closed), и это рабочее состояние: человек ходит в
 * служебную зону сессией оператора.
 */
export function opsCheckToken(env: Record<string, string | undefined>): string {
  return env.OPS_CHECK_TOKEN ?? ''
}

/**
 * Решение служебного роута: пускать или нет, и читать ли статистику.
 *
 * ⚠ Вынесено из роута ради ПОВЕДЕНЧЕСКОЙ проверки: мутация «снять гейт целиком» переживала все
 * тесты, потому что про этот роут не спрашивал никто. Несущее утверждение — «при отказе очереди НЕ
 * читались»: иначе защита исчезает вместе с интерфейсом, а в журнале ничего не остаётся.
 */
export function opsQueuesAllowed(env: Record<string, string | undefined>, provided: string): boolean {
  return opsTokenOk(opsCheckToken(env), provided)
}

export function opsTokenOk(expected: string, provided: string): boolean {
  if (!expected) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(provided)
  return a.length === b.length && timingSafeEqual(a, b)
}
