import type { AgentJob, CrmSyncJob, EventJob, ExtractJob } from './topology'
import type { CrmSyncDeps, CrmSyncResult } from './crmSyncCore'
import { runCrmSync } from './crmSyncCore'
import type { PortalMapping, TargetRef } from '~/types/mapping'
import type { ExtractedDocument } from '~/types/document'
import type { RoutingSignals } from '~/utils/routing'
import { describeLlmFailure, llmErrorSignature, type LlmFailureKind } from '../agent/llmFailure'

// Pure job handlers with DI. Live transports (REST/MCP/DB) are injected in worker.ts;
// tests inject fakes. See docs/PROCESS.md

/** Text kept in the stored signals for keyword routing (the rest is dropped). */
export const MAX_ROUTING_TEXT = 131_072 // 128 KiB — routing keywords sit near the top

const msg = (e: unknown) => (e instanceof Error ? e.message : 'ошибка')

// ── b24-events (install/uninstall) — the consumer is the SINGLE writer of portal_tokens ──

export interface EventHandlerDeps {
  /** Register a portal (ONAPPINSTALL). Returns false when refused by the event-ordering
   *  tombstone guard (a stale/redelivered install after an uninstall). */
  savePortal: (job: EventJob) => Promise<boolean>
  /** Unregister a portal (ONAPPUNINSTALL) — always purge all portal data; writes a tombstone. */
  deletePortal: (memberId: string, eventTs: number) => Promise<void>
  /** Best-effort purge of on-disk uploaded bytes for the portal (data minimisation). */
  purgeFiles?: (memberId: string) => Promise<void>
}

/**
 * Apply a verified install/uninstall packet. Pure orchestration (DI) so BOTH the queue
 * consumer AND the route's synchronous fallback share one code path — no drift.
 * Verification (application_token / access_token TOFU) happens UPSTREAM in the route;
 * this only writes. Unknown event types are ignored. See docs / CLAUDE.md (ported from client-bank).
 */
export async function handleEventJob(job: EventJob, deps: EventHandlerDeps): Promise<void> {
  if (job.event === 'ONAPPUNINSTALL') {
    await deps.deletePortal(job.memberId, job.ts)
    if (deps.purgeFiles) await deps.purgeFiles(job.memberId)
    return
  }
  if (job.event === 'ONAPPINSTALL') {
    await deps.savePortal(job) // tombstone guard lives inside savePortal (eventTs = job.ts)
  }
}

export interface HandlerDeps {
  /** Load the portal mapping (from app.option) for a portal. */
  getMapping: (memberId: string) => Promise<PortalMapping>
  /** Load the extracted document + routing signals for a job (stored by agent-run). */
  getDocument: (memberId: string, jobId: string) => Promise<{ doc: ExtractedDocument, signals: RoutingSignals, failure?: string } | null>
  /** Build the crm-sync deps bound to this portal/job/mapping (in-process tool bodies over REST). */
  crmSyncDeps: (memberId: string, jobId: string, mapping: PortalMapping) => CrmSyncDeps
  /** Persist the job outcome. */
  setJobStatus: (memberId: string, jobId: string, status: 'done' | 'error', result: string) => Promise<void>
  /** Record a terminal failure AND announce it (uploader + error chat). Separate from setJobStatus:
   *  this stage can end 'error' without ever throwing, so BullMQ's exhausted-retries hook never
   *  runs and the failure would otherwise be announced nowhere (BACKLOG.md §1). */
  failJob: (memberId: string, jobId: string, reason: string) => Promise<void>
  /**
   * Best-effort cleanup of the stored raw client document once the job is
   * terminal (data minimisation — docs/PROCESS.md). Optional: a failed sweep
   * must not fail the job. crm-sync does not retry, so the doc is safe to drop
   * after the status is recorded.
   */
  deleteDocument?: (memberId: string, jobId: string) => Promise<void>
  /**
   * Bump per-portal dashboard counters after a crm-sync (best-effort; absent in
   * tests). Covers docs/created/lines/unmatched (fresh run) and skipped (idempotent
   * redelivery); the `errors` counter is bumped upstream in crm-sync's reportErrors,
   * so it is NOT set here (no double count).
   */
  bumpMetrics?: (memberId: string, deltas: Record<string, number>) => Promise<void>
}

/** Handle a crm-sync job: load doc+mapping, run the pure orchestration, record status. */
export async function handleCrmSyncJob(job: CrmSyncJob, deps: HandlerDeps): Promise<CrmSyncResult | null> {
  const loaded = await deps.getDocument(job.memberId, job.jobId)
  if (!loaded) {
    await deps.failJob(job.memberId, job.jobId, 'документ не найден')
    return null
  }
  const mapping = await deps.getMapping(job.memberId)
  const crmDeps = deps.crmSyncDeps(job.memberId, job.jobId, mapping)
  // ⚠ Причина, по которой документ не разобрался, доезжает сюда полем задания и превращается в
  // ЖЁСТКУЮ ОШИБКУ стадии записи (#459): текст уйдёт в чат ошибок и в статус, а карточка-след и
  // дело всё равно будут созданы. Именно ради этого случая журнал импортов и заводился.
  const result = await runCrmSync(job.jobId, loaded.doc, mapping, loaded.signals, {
    ...crmDeps,
    ...(loaded.failure ? { documentFailure: loaded.failure } : {})
  })
  // ⚠ Счётчики поднимаются ДО перевода задания в терминальный статус (#444). Экран читает метрики
  // ровно в момент, когда последнее задание пачки становится `done`, — при обратном порядке между
  // этими двумя действиями лежал апсерт в Postgres, и чтение попадало в окно: человек видел числа
  // «на один документ назад». Промах не самозаживает — второго обновления не будет до следующего
  // импорта, а правдоподобно неверная картинка хуже необновлённой.
  // ⚠ Порядок безопасен: обе операции best-effort, `bumpMetricsSafe` глушит свои отказы, поэтому
  // сбой счётчиков не может помешать заданию получить статус.
  // Dashboard counters. `errors` is bumped upstream (reportErrors) — not here.
  //  - Idempotent redelivery (job already processed): the whole document was SKIPPED — count
  //    it as `skipped` and re-count nothing else (no new doc/entity/rows were produced).
  //  - Fresh run: one document processed, plus (on success) the CRM entity and the product
  //    rows ACTUALLY written (result.rowCount, after skips — not doc.items.length), plus
  //    `unmatched` when the supplier company could not be resolved.
  if (deps.bumpMetrics) {
    await bumpMetricsSafe(deps.bumpMetrics, job.memberId, result.idempotent
      ? { skipped: 1 }
      : {
          docs: 1,
          // ⚠ «Внесено» — это УСПЕШНО внесённые документы, а не созданные карточки (#459). С тех
          // пор как запись создаётся и на отказе, `result.created` перестал означать успех:
          // считая по нему, приложение отчитывалось бы перед клиентом за импорт, которого не было,
          // и плитка «внесено» на главной росла бы от мусорных файлов.
          created: result.created && !result.errors.length ? 1 : 0,
          lines: result.rowCount,
          unmatched: result.unmatched ? 1 : 0
        })
  }
  await deps.setJobStatus(
    job.memberId, job.jobId,
    // ⚠ Статус «Готово» — только когда ошибок НЕТ (#459). Прежнее `result.created || …` читалось
    // как «карточка есть ⇒ всё хорошо», а карточка теперь создаётся и на отказе: неразобранный
    // документ показался бы сотруднику успешно импортированным.
    result.errors.length ? 'error' : 'done',
    // entityTypeId (#192 п.2 — feedback entity link) + supplier name + line count so the /app «разбор»
    // shows what was recognised, not just the id. Portal's own document data, read back only by the
    // same portal's frame token (member-scoped) and rendered auto-escaped — no cross-tenant exposure.
    JSON.stringify({
      entityTypeId: result.entityTypeId,
      entityId: result.entityId,
      created: result.created,
      // Cap the supplier name so a pathological document can't bloat the result column / the UI.
      ...(loaded.doc.supplier?.name ? { supplier: loaded.doc.supplier.name.slice(0, 120) } : {}),
      lines: result.rowCount,
      warnings: result.warnings,
      // Совет отдельным полем, а не строкой в `warnings` (#388): в списке он и раздувал счётчик
      // проблем, и читался как ещё одна поломка документа.
      ...(result.advice ? { advice: result.advice } : {}),
      errors: result.errors
    })
  )
  // Terminal now (status recorded, no crm-sync retry) — drop the raw client
  // document. Best-effort: never fail the job on a cleanup error.
  if (deps.deleteDocument) {
    try {
      await deps.deleteDocument(job.memberId, job.jobId)
    } catch { /* retained rows are swept by a later TTL pass */ }
  }
  return result
}

// ── file-extract ────────────────────────────────────────────────────────────

/** Hard cap on extracted DOCUMENT_TEXT (memory / storage / LLM-cost DoS guard). */
export const MAX_DOCUMENT_TEXT = 500_000

export interface FileExtractDeps {
  /** Extract DOCUMENT_TEXT from the stored file (pdftotext / OCR / office). May throw. */
  extractText: (memberId: string, jobId: string, fileId: string) => Promise<string>
  /** Persist the raw text for agent-run (scoped by job). */
  saveText: (memberId: string, jobId: string, text: string) => Promise<void>
  enqueueAgentRun: (memberId: string, jobId: string, manualTarget?: TargetRef | null) => Promise<void>
  /** Mark the job failed (records an error status the operator sees). */
  failJob: (memberId: string, jobId: string, reason: string) => Promise<void>
  /** Optional progress: mark the job 'extracting' at entry (UI stage indicator). */
  markExtracting?: (memberId: string, jobId: string) => Promise<void>
}

/** file-extract: file → text → enqueue agent-run. Empty/failed/oversized extraction fails the job. */
export async function handleFileExtractJob(job: ExtractJob, deps: FileExtractDeps): Promise<{ ok: boolean }> {
  await markProgress(deps.markExtracting, job.memberId, job.jobId)
  let text: string
  try {
    text = await deps.extractText(job.memberId, job.jobId, job.fileId)
  } catch (e) {
    await deps.failJob(job.memberId, job.jobId, `извлечение текста: ${msg(e)}`)
    return { ok: false }
  }
  if (!text.trim()) {
    await deps.failJob(job.memberId, job.jobId, 'пустой текст документа (файл не распознан)')
    return { ok: false }
  }
  // Loud failure, not silent truncation — dropping tail lines would break 1-в-1.
  if (text.length > MAX_DOCUMENT_TEXT) {
    await deps.failJob(job.memberId, job.jobId, `документ слишком большой (>${MAX_DOCUMENT_TEXT} символов) — разбейте на части`)
    return { ok: false }
  }
  await deps.saveText(job.memberId, job.jobId, text)
  // ⚠ Архивирования на Диск здесь БОЛЬШЕ НЕТ (#458): документ вкладывается в дело таймлайна на
  // стадии crm-sync, поэтому вторая копия на Диске портала стала лишней. Байты остаются на месте
  // до конца конвейера — их удаляет терминальная стадия, а не эта.
  // Выбор цели передаётся дальше вместе с задачей (см. `ExtractJob`), а не перечитывается из стора.
  await deps.enqueueAgentRun(job.memberId, job.jobId, job.manualTarget)
  return { ok: true }
}

// ── agent-run ─────────────────────────────────────────────────────────────────

export interface AgentRunDeps {
  /** Load the raw DOCUMENT_TEXT for the job (from file-extract). */
  getDocumentText: (memberId: string, jobId: string) => Promise<string | null>
  /** Run the extraction agent → validated document (null = nothing usable). */
  extractDocument: (documentText: string) => Promise<{ document: ExtractedDocument | null, error?: string, own?: true }>
  /** Persist the extracted structure + routing signals for crm-sync. */
  saveDocument: (memberId: string, jobId: string, stored: { doc: ExtractedDocument, signals: RoutingSignals, failure?: string }) => Promise<void>
  enqueueCrmSync: (memberId: string, jobId: string) => Promise<void>
  failJob: (memberId: string, jobId: string, reason: string) => Promise<void>
  /** Optional: operator's manual target override chosen next to the file. */
  getManualOverride?: (memberId: string, jobId: string) => Promise<TargetRef | undefined>
  /** Optional best-effort: drop the raw text (on success AND on terminal failure). */
  deleteText?: (memberId: string, jobId: string) => Promise<void>
  /** Optional progress: mark the job 'processing' once extraction begins. */
  markProcessing?: (memberId: string, jobId: string) => Promise<void>
  /**
   * Optional: record an LLM refusal in the server log (#416).
   *
   * Принимает КЛАСС и просеянную подпись, а не исходную строку — так «залогировать сырую ошибку»
   * невозможно по сигнатуре, а не по договорённости.
   */
  logLlmFailure?: (kind: LlmFailureKind, signature: string) => void
}

/**
 * Документ-заглушка для загрузки, которую не удалось разобрать (#459).
 *
 * ⚠ Позиций нет и быть не может: разбор не состоялся. Всё, что несёт это задание дальше, —
 * причина отказа в поле `failure`, по которой стадия записи создаст карточку-след и дело.
 */
const EMPTY_DOCUMENT: ExtractedDocument = { items: [] }

/** agent-run: text → extract structure → store {doc, signals} → enqueue crm-sync. */
/**
 * Итог стадии распознавания.
 *
 * ⚠ `handedOn` — «задание поехало дальше, на стадию записи». Отдельно от `ok`, и это НЕ
 * педантизм: с #459 неудачное распознавание тоже ставится в `crm-sync` (там создаётся
 * карточка-след с вложенным документом), то есть `ok:false` перестал означать «конвейер
 * закончился». Воркер по этому флагу решает, можно ли удалять загруженные байты, — спутав их,
 * он стирает файл ровно перед тем, как стадия записи попытается его вложить.
 */
export interface AgentRunOutcome { ok: boolean, handedOn: boolean }

export async function handleAgentRunJob(job: AgentJob, deps: AgentRunDeps): Promise<AgentRunOutcome> {
  const text = await deps.getDocumentText(job.memberId, job.jobId)
  if (!text) {
    await deps.failJob(job.memberId, job.jobId, 'текст документа не найден')
    // Единственный путь, который ДЕЙСТВИТЕЛЬНО терминален на этой стадии: текста нет, разбирать
    // нечего, и в запись задание не поедет.
    return { ok: false, handedOn: false }
  }
  await markProgress(deps.markProcessing, job.memberId, job.jobId)
  const { document, error, own } = await deps.extractDocument(text)
  if (!document) {
    // ⚠ Наружу уходит НАШ текст по классу отказа, а не строка провайдера (#416): она ничего не
    // объясняет человеку и вправе процитировать присланный запрос, то есть текст документа
    // клиента. Исходная строка остаётся только в журнале, и туда идёт просеянной.
    const { kind, message } = describeLlmFailure(error, own)
    deps.logLlmFailure?.(kind, llmErrorSignature(error))
    // ⚠ Задание НЕ завершается здесь (#459): оно едет дальше, на стадию записи, потому что
    // сущность и дело создаются на КАЖДУЮ загрузку — включая ту, что не разобралась. Прежде
    // конвейер обрывался ровно тут, и самый интересный для человека случай не оставлял в портале
    // ни следа: ни карточки, ни дела, ни строки в журнале импортов.
    // ⚠ Статус «Ошибка» и сообщение человеку ставит стадия записи — по тому же тексту. Звать
    // `failJob` здесь значило бы отправить два уведомления об одном документе.
    // ⚠ Текст документа удаляется, как и раньше: повторное извлечение того же текста ничего не
    // изменит, а хранить неразобранные документы клиента незачем.
    await deps.saveDocument(job.memberId, job.jobId, { doc: EMPTY_DOCUMENT, signals: { text: '' }, failure: message })
    await deps.enqueueCrmSync(job.memberId, job.jobId)
    await dropText(deps.deleteText, job.memberId, job.jobId)
    // ⚠ `handedOn: true` — задание ПОЕХАЛО ДАЛЬШЕ. Байты обязаны дожить до стадии записи: там
    // документ вкладывается в карточку-след, и именно у неразобранного документа вложение нужнее
    // всего — разбирать нечего, человек открывает оригинал.
    return { ok: false, handedOn: true }
  }
  // ⚠ Сначала — то, что приехало С ЗАДАЧЕЙ, и только потом запись задания. Порядок именно такой:
  // запись живёт ограниченный срок и при долгом ожидании в очереди могла истечь, а «ничего не
  // вернулось» неотличимо от «человек ничего не выбирал» — документ ушёл бы по правилам, молча и
  // не туда, куда его отправляли. Чтение из стора оставлено для задач, поставленных ДО этой правки
  // (они уже лежат в очереди без нового поля) и для путей, где полезная нагрузка её не несёт.
  const manualOverride = job.manualTarget ?? (deps.getManualOverride ? await deps.getManualOverride(job.memberId, job.jobId) : undefined)
  const signals: RoutingSignals = {
    ...(document.documentType ? { documentType: document.documentType } : {}),
    text: text.slice(0, MAX_ROUTING_TEXT),
    ...(manualOverride ? { manualOverride } : {})
  }
  await deps.saveDocument(job.memberId, job.jobId, { doc: document, signals })
  // Enqueue BEFORE dropping the text: if enqueue throws, the text survives for the
  // job retry (delete-then-enqueue would orphan the document on a transient blip).
  await deps.enqueueCrmSync(job.memberId, job.jobId)
  // Raw text now lives (bounded) in the doc payload → drop the standalone copy.
  await dropText(deps.deleteText, job.memberId, job.jobId)
  return { ok: true, handedOn: true }
}

/** Best-effort progress marker — a failed status write must never fail the job. */
async function markProgress(fn: ((m: string, j: string) => Promise<void>) | undefined, memberId: string, jobId: string): Promise<void> {
  if (!fn) return
  try {
    await fn(memberId, jobId)
  } catch { /* progress is advisory */ }
}

/** Best-effort dashboard-counter bump — a metrics write must never fail the job. */
async function bumpMetricsSafe(fn: (m: string, d: Record<string, number>) => Promise<void>, memberId: string, deltas: Record<string, number>): Promise<void> {
  try {
    await fn(memberId, deltas)
  } catch { /* counters are advisory — never fail the import on a metrics write */ }
}

/** Best-effort raw-text cleanup — a failed sweep must never fail the job. */
async function dropText(fn: ((m: string, j: string) => Promise<void>) | undefined, memberId: string, jobId: string): Promise<void> {
  if (!fn) return
  try {
    await fn(memberId, jobId)
  } catch { /* retained rows are purged on uninstall / swept by TTL */ }
}
