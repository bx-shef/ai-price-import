import type { FetchFn } from './b24Rest'
import type { FeedbackConfig } from './feedbackConfig'
import type { FeedbackIssueRef } from './feedbackRetention'

// Служебные вызовы к приёмнику отзывов (#417): перечислить и стереть. DI над `FetchFn`.
//
// SECURITY: ни токен, ни адрес, ни тело ответа в журнал не идут — тело задачи-отзыва содержит
// данные клиента, а адрес несёт токен в заголовке. Наружу отдаётся только результат операции.

const API = 'https://api.github.com'

function headers(config: FeedbackConfig): Record<string, string> {
  return {
    'Authorization': `Bearer ${config.token}`,
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'procure-ai-feedback',
    'X-GitHub-Api-Version': '2022-11-28'
  }
}

/**
 * Страница самых СТАРЫХ задач приёмника (любого состояния).
 *
 * `sort=created&direction=asc` — не украшение: чистке нужны просроченные, то есть самые старые, и
 * так первая же страница их и содержит. Сортировка по обновлению вернула бы свежие, и чистка
 * годами не доходила бы до тех, ради кого заведена.
 *
 * ⚠ Отбираются только НАШИ задачи (`labels=user-feedback`): в приёмнике владельца могут лежать и
 * его собственные заметки, а удаление задачи необратимо.
 */
export async function listOldestFeedbackIssues(config: FeedbackConfig, limit: number, fetchFn: FetchFn): Promise<FeedbackIssueRef[] | null> {
  const per = Math.min(100, Math.max(1, limit))
  let res: Awaited<ReturnType<FetchFn>>
  try {
    res = await fetchFn(`${API}/repos/${config.repo}/issues?state=all&sort=created&direction=asc&labels=user-feedback&per_page=${per}`, {
      method: 'GET',
      headers: headers(config)
    })
  } catch {
    return null
  }
  if (res.status !== 200) return null
  const body = await res.json().catch(() => null)
  if (!Array.isArray(body)) return null
  const out: FeedbackIssueRef[] = []
  for (const raw of body) {
    const r = raw as Record<string, unknown>
    // Запросы на слияние приходят тем же списком и задачами не являются.
    if (r.pull_request) continue
    const number = Number(r.number)
    const nodeId = String(r.node_id ?? '')
    const createdAt = String(r.created_at ?? '')
    if (!Number.isInteger(number) || number <= 0 || !nodeId || !createdAt) continue
    out.push({ number, nodeId, createdAt, body: String(r.body ?? '') })
  }
  return out
}

/**
 * Удалить задачу целиком, вместе с комментариями.
 *
 * ⚠ Только GraphQL: у REST-интерфейса удаления задачи нет вовсе, а правка тела — не удаление
 * (прежний текст остаётся в истории правок, доступной всем, у кого есть доступ к приёмнику).
 */
export async function deleteFeedbackIssue(config: FeedbackConfig, nodeId: string, fetchFn: FetchFn): Promise<boolean> {
  let res: Awaited<ReturnType<FetchFn>>
  try {
    res = await fetchFn(`${API}/graphql`, {
      method: 'POST',
      headers: headers(config),
      body: JSON.stringify({
        query: 'mutation($id:ID!){ deleteIssue(input:{issueId:$id}){ clientMutationId } }',
        variables: { id: nodeId }
      })
    })
  } catch {
    return false
  }
  if (res.status !== 200) return false
  // ⚠ GraphQL отвечает 200 и на отказ — ошибка лежит в теле. Без этой проверки чистка
  // рапортовала бы об удалении задач, которые остались на месте.
  const body = await res.json().catch(() => null)
  const errs = (body as { errors?: unknown[] } | null)?.errors
  return !(Array.isArray(errs) && errs.length > 0)
}

/**
 * Удалить приложенный файл из приёмника.
 *
 * Двухшаговый: интерфейс содержимого требует `sha` текущего блоба, иначе удаление не принимается.
 * Файла уже нет (404) — считаем успехом: цель достигнута, а повторный прогон не должен вечно
 * рапортовать об ошибке.
 *
 * ⚠ Это удаление из ВЕТКИ, а не из истории. Содержимое остаётся достижимо по хэшу объекта, пока
 * история не переписана; в PROCESS.md это записано как остаточный риск, а не как сделанное.
 */
export async function deleteFeedbackFile(config: FeedbackConfig, path: string, fetchFn: FetchFn): Promise<boolean> {
  const url = `${API}/repos/${config.repo}/contents/${path}`
  let head: Awaited<ReturnType<FetchFn>>
  try {
    head = await fetchFn(url, { method: 'GET', headers: headers(config) })
  } catch {
    return false
  }
  if (head.status === 404) return true
  if (head.status !== 200) return false
  const meta = await head.json().catch(() => null)
  const sha = String((meta as { sha?: unknown } | null)?.sha ?? '')
  if (!sha) return false
  let res: Awaited<ReturnType<FetchFn>>
  try {
    res = await fetchFn(url, {
      method: 'DELETE',
      headers: headers(config),
      body: JSON.stringify({ message: 'retention: remove expired feedback file', sha })
    })
  } catch {
    return false
  }
  return res.status === 200
}
