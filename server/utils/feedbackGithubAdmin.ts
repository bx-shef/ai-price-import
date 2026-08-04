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
    const labels = Array.isArray(r.labels)
      ? r.labels.map(l => String((l as { name?: unknown })?.name ?? l ?? '')).filter(Boolean)
      : []
    out.push({ number, nodeId, createdAt, title: String(r.title ?? ''), body: String(r.body ?? ''), labels })
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
 * Файлы каталога приёмника: `null` — не прочитали (сеть/права), `[]` — каталога нет.
 *
 * ⚠ Каталог — единственный источник правды о путях. Разбирать их из тела задачи нельзя: туда
 * попадает свободный текст сотрудника, и чужая ссылка в комментарии увела бы удаление на документ
 * другого портала.
 *
 * ⚠ 404 — это `[]`, а не отказ: каталог мог быть удалён прошлым прогоном или отзыв пришёл без
 * файла. Прочие коды — отказ, потому что «нет прав» и «нет каталога» на приватном репозитории
 * выглядят одинаково, а принять отказ за пустоту значит стереть задачу и оставить документ.
 */
export async function listFeedbackDir(config: FeedbackConfig, dir: string, fetchFn: FetchFn): Promise<string[] | null> {
  let res: Awaited<ReturnType<FetchFn>>
  try {
    res = await fetchFn(`${API}/repos/${config.repo}/contents/${dir}`, { method: 'GET', headers: headers(config) })
  } catch {
    return null
  }
  if (res.status === 404) return []
  if (res.status !== 200) return null
  const body = await res.json().catch(() => null)
  // Одиночный файл вместо каталога отдаётся объектом — для нас это тоже «ничего не нашли».
  if (!Array.isArray(body)) return []
  const out: string[] = []
  for (const raw of body) {
    const r = raw as Record<string, unknown>
    const path = String(r.path ?? '')
    // Путь берём ТОЛЬКО из ответа GitHub и только внутри запрошенного каталога.
    if (r.type === 'file' && path.startsWith(`${dir}/`)) out.push(path)
  }
  return out
}

/**
 * Удалить приложенный файл из приёмника.
 *
 * Двухшаговый: интерфейс содержимого требует `sha` текущего блоба, иначе удаление не принимается.
 *
 * ⚠ 404 здесь — ОТКАЗ, а не успех. Путь только что пришёл из листинга того же каталога, значит
 * файл существовал; 404 в ответ означает нехватку прав или гонку, а не достигнутую цель. Прежняя
 * трактовка «404 = уже нет» позволяла стереть задачу при живом документе и отчитаться нулём
 * отказов.
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

/** Текст, остающийся вместо содержимого при деградации. */
export const REDACTED_BODY = 'Содержимое отзыва удалено по истечении срока хранения (12 месяцев, п. 8.6 Политики конфиденциальности).'

/**
 * Деградация, когда удалить задачу нечем: обезличить тело и заголовок, закрыть, снять метки.
 *
 * ⚠ Метки снимаются ОБЯЗАТЕЛЬНО — и метка канала, и псевдоним портала. Без этого задача осталась
 * бы в выборке чистки навсегда и на следующие сутки заняла бы то же место в очереди: пятьдесят
 * таких задач закрыли бы обзор всего остального, и чистка не сдвинулась бы больше никогда.
 * Снятый псевдоним заодно убирает признак, по которому обезличенную задачу можно связать с
 * клиентом.
 */
export async function redactFeedbackIssue(config: FeedbackConfig, issueNumber: number, fetchFn: FetchFn): Promise<boolean> {
  let res: Awaited<ReturnType<FetchFn>>
  try {
    res = await fetchFn(`${API}/repos/${config.repo}/issues/${issueNumber}`, {
      method: 'PATCH',
      headers: headers(config),
      body: JSON.stringify({ title: 'Отзыв (удалён по сроку хранения)', body: REDACTED_BODY, state: 'closed', labels: [] })
    })
  } catch {
    return false
  }
  return res.status === 200
}
