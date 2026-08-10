import { buildJournalQuery, mapJournalRows, JOURNAL_PAGE_SIZE, type JournalRow } from './importJournal'

// Решение роута журнала — ЧИСТАЯ функция с внедрёнными зависимостями (#458).
//
// Вынесено из `server/api/import/journal.get.ts` по той же причине, по которой в проекте вынесены
// `metricsHandler` и `appRatingHandler`: у роута пять веток, и четыре из них — отказы, каждый со
// своим кодом. Внутри `defineEventHandler` они недостижимы тестом, а именно там живёт защита
// приватности: пропавшая проверка `userId` превращает «мои импорты» в «импорты всего портала», и
// по виду экрана это неотличимо — список просто длиннее.

export interface JournalAuth {
  ok: boolean
  memberId?: string
  /** Id сотрудника из ПРОВЕРЕННОГО фрейм-токена (`profile.ID`). */
  userId?: string
  status?: 401 | 502
  reason?: string
}

export interface JournalDeps {
  /** Проверка фрейм-токена → портал + сотрудник. */
  authorize: () => Promise<JournalAuth>
  /** Транспорт к порталу под его OAuth-токеном. `null` — приложение не установлено. */
  resolveCall: (memberId: string) => Promise<((method: string, params: Record<string, unknown>) => Promise<unknown>) | null>
  /** Код внешнего источника — им помечены наши дела. */
  originatorCode: string
}

export interface JournalResponse {
  status: number
  /** Исход для телеметрии — те же значения, что у остальных фрейм-роутов. */
  outcome: 'ok' | 'no_auth' | 'auth_failed' | 'forbidden' | 'conflict' | 'upstream_error'
  body: { rows: JournalRow[], hasMore: boolean, start: number } | { error: string, reason?: string }
}

/**
 * Отдать страницу журнала сотруднику.
 *
 * ⚠ Порядок проверок — не косметика. Сначала «кто портал», потом «кто человек»: без второго
 * выборка не сужается, и роут отдал бы дела всего портала. Поэтому отсутствие `userId` — ОТКАЗ
 * (403), а не «покажем всё».
 * ⚠ Отказ чтения портала — 502, а НЕ пустой список. «Импортов не было» и «мы не смогли
 * посмотреть» для человека противоположны по смыслу, а выглядят одинаково (пустой экран) — тот же
 * дефект, что чинили в #408.
 */
export async function journalRequest(rawStart: unknown, deps: JournalDeps): Promise<JournalResponse> {
  const auth = await deps.authorize()
  if (!auth.ok || !auth.memberId) {
    return {
      status: auth.status ?? 401,
      outcome: auth.status === 502 ? 'upstream_error' : 'auth_failed',
      body: { error: 'authorization failed', ...(auth.reason ? { reason: auth.reason } : {}) }
    }
  }
  if (!auth.userId) {
    return { status: 403, outcome: 'forbidden', body: { error: 'user id unavailable' } }
  }

  const start = Number(rawStart)
  const params = buildJournalQuery(deps.originatorCode, auth.userId, start)
  let call: Awaited<ReturnType<JournalDeps['resolveCall']>>
  try {
    call = await deps.resolveCall(auth.memberId)
  } catch {
    return { status: 502, outcome: 'upstream_error', body: { error: 'journal unavailable' } }
  }
  if (!call) {
    return { status: 409, outcome: 'conflict', body: { error: 'portal not authorised (no token)' } }
  }

  try {
    const res = await call('crm.activity.list', params)
    // Транспорт SDK разворачивает `result` сам, но список может прийти и объектом с `items` —
    // принимаем обе формы, потому что молчаливо пустой журнал неотличим от «импортов не было».
    const raw = Array.isArray(res) ? res : (res as { items?: unknown } | null)?.items
    const rows = mapJournalRows(raw)
    // ⚠ «Есть ещё» считается по РАЗМЕРУ ПОЛУЧЕННОЙ страницы, а не по `total` портала: выборка
    // сужена нашим маркером и сотрудником, и `total` описывает не то множество, которое видит
    // человек. Сравнение нестрогое: портал вправе вернуть ровно страницу и иметь продолжение.
    // ⚠ «Есть ещё» считается по СЫРОЙ странице портала, а не по отфильтрованной (разбор #495):
    // `mapJournalRows` выбрасывает дела без нашего маркера (его могли стереть руками), и по
    // отфильтрованной длине полная страница выглядела бы неполной — кнопка «Дальше» гасла, и
    // остаток журнала становился недостижим НАВСЕГДА, без единого сообщения.
    const pageSize = Array.isArray(raw) ? raw.length : 0
    return { status: 200, outcome: 'ok', body: { rows, hasMore: pageSize >= JOURNAL_PAGE_SIZE, start: params.start } }
  } catch {
    return { status: 502, outcome: 'upstream_error', body: { error: 'journal unavailable' } }
  }
}
