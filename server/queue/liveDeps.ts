import type { QueryFn } from '../utils/tokenStore'
import type { RestCall } from '../utils/b24Rest'
import type { ExtractRunners } from '../utils/textExtract'
import type { EnsureDeps } from '../utils/ensureAccessToken'
import { ensureFreshToken } from '../utils/ensureAccessToken'
import { selectTokensNearExpiry, type KeepAliveDeps } from '../utils/tokenKeepAlive'
import { deletePortal, getBotId, getToken, saveBotId, saveToken, updateTokensOnRefresh } from '../utils/tokenStore'
import { withAdvisoryLock } from '../utils/dbLock'
import { createPortalSdkResolver, makePortalSdkCall, sdkPortalDeps, sdkRefreshTransport, type PortalSdkResolver, type SdkTransport } from '../utils/b24Sdk'
import { buildBotUnregister, createBotIdCache, errorCode, forgetPortalBot, pushBotProfile, resolveBotId } from '../utils/chatBot'
import { purgePortalFiles } from '../utils/nodeFileIO'
import { decryptSecret, encryptSecret } from '../utils/secretCrypto'
import { claimJobErrorChat, claimJobFailNotify, claimJobNotify, getJob, getManualOverride, getUploaderId, setJobStatus } from '../utils/jobStore'
import { jobRedis } from '../utils/jobStoreRedis'
import { getText, saveText, deleteText } from '../utils/textStore'
import { getDocument, saveDocument, deleteDocument } from '../utils/docStore'
import { findExistingItemId } from '../utils/originLookup'
import { bumpCounter, METRICS } from '../utils/metricsStore'
import { readMapping } from '../utils/appSettings'
import { defaultMapping } from '~/utils/portalSettings'
import { findCompanyByTaxId } from '../utils/companyLookup'
import { fetchCrmCategories } from '../utils/categoryLookup'
import { fetchCrmMode, leadsEnabled } from '../utils/crmMode'
import { findProduct } from '../utils/productLookup'
import { NO_IBLOCKS, resolveIblocks, type CatalogIblocks } from '../utils/catalogLookup'
import { fetchMeasureRows } from '../utils/measureList'
import { createMeasureViaRest } from '../utils/measureCreateWrite'
import { buildMeasureIndex, lookupExistingMeasure, normalizeUnitKey, MAX_AUTO_MEASURES_PER_JOB, type MeasureIndex } from '~/utils/measureCreate'
import { fetchVatRates } from '../utils/portalVat'
import { fetchCurrencies } from '../utils/portalCurrency'
import { createTargetItem, setProductRows } from '../utils/crmWrite'
import { buildActivityInput, buildActivityMarkerFields, buildFileAttachment, buildTodoActivity } from '../utils/todoActivity'
import { originatorCode } from '../utils/originMarker'
import { buildErrorMessage, buildSuccessMessage, sendChatMessage } from '../utils/chatNotify'
import { planFailureNotify } from '../utils/failureNotify'
import { extractText } from '../utils/textExtract'
import { uploadPath } from '../utils/fileStore'
import { portalHash } from '../utils/telemetryAttributes'
import { runChatExtract, type ChatFn } from '../agent/chatExtract'
import { buildExtractionPrompt } from '../../prompts/extract'
import { enqueueAgent, enqueueCrmSync } from './producers'
import type { AgentRunDeps, EventHandlerDeps, FileExtractDeps, HandlerDeps } from './handlers'
import { eventJobToSaveInput } from './topology'
import type { CrmSyncDeps } from './crmSyncCore'
import type { PortalMapping } from '~/types/mapping'
import { portalAppUrl } from '~/config/b24'
import { fetchAppId } from '../utils/appInfo'

// Live wiring: bind the pure handlers' DI to real stores / portal REST / extractor / queues.
// The chat extractor transport, file-extract runners and the OAuth refresh HTTP are INJECTED
// via LiveInfra so this module stays free of untestable globals and typecheck validates every
// binding. See docs/PROCESS.md

export interface LiveInfra {
  query: QueryFn
  /** AES key (base64) for refresh-token decrypt/encrypt. */
  encKey: string
  clientId: string
  clientSecret: string
  now: () => number
  /** Live chat transport (OpenAI-compatible — DeepSeek/BitrixGPT). Throws a clear error per call
   *  when the provider key is unset (fail-closed); never null so extraction has a single path. */
  chatFn: ChatFn
  /** Model id for the extractor (e.g. deepseek-v4-flash / bitrix/bitrixgpt-5.5). */
  llmModel: string
  /** File → text runners (pdftotext / office / OCR). */
  runners: ExtractRunners
}

/** EnsureDeps for OAuth refresh, bound to the shared infra. */
function ensureDeps(infra: LiveInfra): EnsureDeps {
  return {
    getToken: m => getToken(m, infra.query),
    // Refresh serialized per portal (advisory lock, #35); re-read + persist run on the
    // LOCKED connection. persistRefresh is UPDATE-only (never resurrects a purged portal).
    withLock: withAdvisoryLock,
    loadToken: (q, m) => getToken(m, q),
    persistRefresh: (q, input) => updateTokensOnRefresh(input, q),
    // Refresh THROUGH the SDK (@bitrix24/b24jssdk `refreshAuth`) — single transport, and
    // secrets ride in the POST body (the old hand-rolled POST put them in the URL query). Its
    // own timeout bounds the call: it runs INSIDE the advisory lock holding a pooled connection,
    // so a hung OAuth server must not pin the lock (dbLock's invariant — statement_timeout /
    // lock_timeout don't cover an HTTP await). Persist stays UPDATE-only via persistRefresh above.
    refreshTransport: sdkRefreshTransport(),
    decrypt: enc => (enc ? decryptSecret(enc, infra.encKey) : ''),
    encrypt: plain => encryptSecret(plain, infra.encKey),
    clientId: infra.clientId,
    clientSecret: infra.clientSecret,
    now: infra.now
  }
}

/** Per-portal RestCall resolver — @bitrix24/b24jssdk transport (built-in RestrictionManager:
 * per-portal leaky-bucket rate limiter + retry-backoff on QUERY_LIMIT_EXCEEDED/429/5xx).
 *
 * MEMOIZES one `B24OAuth` per portal (createPortalSdkResolver, #123/#163): a crm-sync job calls
 * the resolver ~9 times (each `need()` in liveCrmSyncDeps), so building fresh per call meant 9
 * clients/job — 9 rate-limiter buckets + 9 token loads, defeating the "one client per job"
 * invariant. Now those calls share ONE bucket + ONE token load. The cache is kept safe against an
 * external refresh-token rotation (a peer replica or the keep-alive cron #175 rotates it, leaving
 * this client's in-memory refresh token stale) by TWO valves: a short TTL (SDK_CLIENT_TTL_MS) and
 * EVICT-ON-ERROR (a failed call drops the client, so the next resolve rebuilds from the current DB
 * token at once — no permanent invalid_grant wedge). `loadToken` is one cheap query;
 * refresh-persist is UPDATE-only (never resurrects a purged portal).
 *
 * NB (accepted): the crm-sync and file-extract dep builders each construct their OWN resolver
 * (their own cache), so a portal hit by BOTH queues at once briefly has two limiter buckets. The
 * SDK backs off on QUERY_LIMIT_EXCEEDED and the two queues rarely co-fire on one portal, so this
 * is left as-is rather than threading one shared resolver through both builders. */
function restResolver(infra: LiveInfra): PortalSdkResolver {
  const deps = sdkPortalDeps(infra)
  return createPortalSdkResolver(memberId => makePortalSdkCall(memberId, deps), infra.now)
}

/**
 * Load the portal mapping via server-side REST for the crm-sync job.
 *
 * ⚠ THROWS on a read failure instead of falling back to defaults (#373). While the default for
 * `product.onMissing` was `skip-warn`, the fallback happened to coincide with the conservative
 * option; now the default WRITES rows. A single transient `app.option.get` hiccup (rate limit,
 * token race, REST 5xx) would therefore import the document under the OPPOSITE policy of the one
 * the admin chose — free-form positions he explicitly forbade, landing in a real deal with an
 * origin marker, which no retry removes. The same fallback also silently substitutes the default
 * funnel for the configured one.
 *
 * Throwing makes the job fail and BullMQ retry it, which is the correct treatment for «настройки
 * прочитать не удалось»: crm-sync is idempotent by marker, so a retry cannot duplicate. There is no
 * token at all ⇒ nothing can be read or written for this portal, same conclusion.
 */
async function loadMapping(memberId: string, rest: (m: string) => Promise<SdkTransport | null>): Promise<PortalMapping> {
  const t = await rest(memberId)
  if (!t) throw new Error('mapping unavailable: no portal token')
  return await readMapping(t.call)
}

/** Keep-alive deps (#175): select near-expiry portals + force-refresh each under the
 *  per-portal lock (reuses ensureFreshToken → advisory lock + UPDATE-only persist). */
export function liveKeepAliveDeps(infra: LiveInfra): KeepAliveDeps {
  const ens = ensureDeps(infra)
  return {
    now: infra.now,
    selectNearExpiry: nowMs => selectTokensNearExpiry(infra.query, nowMs),
    refreshPortal: async (memberId) => {
      try {
        // force → always rotates (resets the 180-day clock even if the access token somehow
        // isn't expired). ensureFreshToken does its own read (unlocked fast-path + a re-read
        // INSIDE the advisory lock), so a separate pre-read here would just be a wasted query.
        await ensureFreshToken(memberId, ens, true)
        return 'refreshed'
      } catch (e) {
        // A vanished portal (uninstalled before the read, or between it and the lock) makes
        // ensureFreshToken throw "no token" — a benign skip, NOT a dead grant. Anything else
        // (invalid_grant, removed app, PAYMENT_REQUIRED) propagates to the caller's per-portal
        // isolation, which logs it and carries on.
        if ((e as { message?: string })?.message?.includes('no token')) return 'skipped'
        throw e
      }
    },
    log: msg => console.info(msg),
    warn: msg => console.warn(msg)
  }
}

/** b24-events deps: the SINGLE writer of portal_tokens (install/uninstall). */
/**
 * Install/uninstall wiring. `opts` exists ONLY as a test seam: the bot side of both events is pure
 * ordering (bot before the portal row is deleted, profile after registration), and without a seam
 * that ordering could only be checked against a live portal — i.e. never (#360 review).
 */
export function liveEventDeps(
  infra: LiveInfra,
  opts: {
    onInstalled?: (memberId: string) => Promise<void>
    unregisterBot?: (memberId: string) => Promise<void>
  } = {}
): EventHandlerDeps {
  return {
    savePortal: async (job) => {
      const saved = await saveToken(eventJobToSaveInput(job), infra.query, job.ts)
      // Register the chat bot AT INSTALL, not at the first message (#316, owner ask — there are no
      // portals installed before the `imbot` scope, so nothing needs the lazy path as its only
      // chance). Doing it here rather than on the `/install` page keeps it server-side, where the
      // portal token already lives. Best-effort: a portal that cannot have a bot (free plan, bot
      // limit) must still install — the send path falls back on its own.
      if (saved) await (opts.onInstalled ?? (m => setUpPortalBot(m, infra)))(eventJobToSaveInput(job).memberId)
      return saved
    },
    deletePortal: async (m, ts) => {
      // Bot first: after the row is gone there is no token left to remove it with (#360).
      await (opts.unregisterBot ?? (id => unregisterPortalBot(id, infra)))(m)
      await deletePortal(m, infra.query, ts)
    },
    purgeFiles: m => purgePortalFiles(m)
  }
}

/** file-extract deps: real extract runners + text store + queue + status. */
/**
 * Announce a failed import: to the person who uploaded it, and to the admin's error chat
 * (BACKLOG.md §1). Until this existed, a failure outside crm-sync was visible ONLY in that person's
 * own list of operations, which they see only if they happen to reopen the app.
 *
 * WHAT is said and to WHOM is decided by the pure `planFailureNotify`; this function is the I/O
 * around it. `alsoErrorChat` is false for the one path that posts its own error-chat message
 * (crm-sync hard errors), so one failure never reads as two.
 *
 * Best-effort throughout — a chat hiccup must not turn a recorded failure into an unrecorded one.
 */
/**
 * Bot id for a portal (#316) — pure resolution lives in `chatBot.resolveBotId`; here it is only
 * bound to the live token store. The cache is module-level ON PURPOSE: it must outlive a single job
 * so a batch of documents from one portal does not re-ask the portal about its bot per document.
 */
const botIdCache = createBotIdCache()

export function resolvePortalBotId(memberId: string, infra: LiveInfra, call: () => Promise<RestCall>): Promise<number> {
  return resolveBotId(memberId, {
    getBotId: m => getBotId(m, infra.query),
    saveBotId: (m, id) => saveBotId(m, id, infra.query),
    call,
    log: console.warn,
    // Count the refusal (#360). Without it a portal that cannot have a bot degrades in complete
    // silence — the send falls back, the employee still gets the message, and nobody learns that
    // this portal signs its notices with a person's name.
    onRefused: m => bumpCounter(m, METRICS.botRefused, 1, infra.query).catch(() => {})
  }, botIdCache)
}

export async function setUpPortalBot(memberId: string, infra: LiveInfra): Promise<void> {
  const call = async () => {
    const t = await restResolver(infra)(memberId)
    if (!t) throw new Error('нет транспорта портала')
    return t.call
  }
  const botId = await resolvePortalBotId(memberId, infra, call).catch(() => 0)
  // `log` is not optional in practice: without it a refused profile update leaves no trace at
  // all — no log line, no counter. The function swallows the error itself, so no outer catch.
  if (botId) await pushBotProfile(botId, call, console.warn)
}

/**
 * Remove the portal's bot BEFORE its row is deleted (#360) — afterwards there is no token to speak
 * with, and the bot would outlive the app that created it. Best-effort: uninstall must complete
 * even if the portal refuses, and a bot we cannot remove is a leftover, not a failure.
 */
export async function unregisterPortalBot(memberId: string, infra: LiveInfra): Promise<void> {
  // Drop the remembered refusal too: a reinstall within the TTL must try registration again.
  forgetPortalBot(memberId, botIdCache)
  try {
    const botId = await getBotId(memberId, infra.query)
    const req = buildBotUnregister(botId)
    if (!req) return
    const t = await restResolver(infra)(memberId)
    if (!t) return
    await t.call(req.method, req.params)
  } catch (e) {
    console.warn(`[chat-bot] unregister skipped: ${errorCode(e)}`)
  }
}

export async function notifyImportFailure(
  infra: LiveInfra,
  memberId: string,
  jobId: string,
  reason: string,
  // `appUrl` — уже разрешённый адрес приложения на портале. Его передаёт crm-sync, где на одном
  // отказе адрес нужен и здесь, и в сообщении в чат ошибок: без передачи строка портала читалась бы
  // из Postgres дважды за одну обработку, узнавая второй раз ровно то же самое (#385).
  // ⚠ Ключ значим: `undefined` — «не передавали, разреши сам», `null` — «разрешали, адреса нет»,
  // и его нельзя лечить фолбэком на своё чтение, иначе мемо вызывающего перестало бы работать
  // ровно в том случае, ради которого заведено (домена нет / база недоступна).
  opts: { alsoErrorChat?: boolean, rest?: (m: string) => Promise<SdkTransport | null>, mapping?: PortalMapping, appUrl?: string | null } = {}
): Promise<void> {
  try {
    // Resolve the transport FIRST. Claiming before this burnt the once-only right to speak even
    // when there was no token to speak with — the failure was then silenced forever.
    const rest = opts.rest ?? restResolver(infra)
    const t = await rest(memberId)
    if (!t) return
    if (!(await claimJobFailNotify(memberId, jobId, jobRedis))) return
    const job = await getJob(memberId, jobId, jobRedis)
    const uploaderId = await getUploaderId(memberId, jobId, jobRedis)
    const mapping = opts.mapping ?? await readMapping(t.call).catch(() => defaultMapping())
    const errorChatId = mapping.errorChatId ?? null
    // No quiet period on the error chat (owner's call): the admin is told about EVERY failed
    // document. Repetition is the signal — ten identical messages mean a systemic break, and a
    // throttle that hid nine of them would hide exactly that. Duplicates for the SAME job are still
    // impossible (claimJobFailNotify above); what repeats is distinct documents.
    // Signed by the app, not by the employee (#316). Resolved once per notification; 0 = no bot
    // on this portal, and the send falls back to im.message.add.
    const notifyBotId = await resolvePortalBotId(memberId, infra, async () => t.call)
    const planned = planFailureNotify({
      claimed: true,
      uploaderId,
      fileName: job?.fileName ?? '',
      reason,
      errorChatId,
      alsoErrorChat: opts.alsoErrorChat !== false,
      jobId,
      appUrl: 'appUrl' in opts ? opts.appUrl ?? null : await backLinkUrl(memberId, uploaderId, infra, t.call)
    })
    for (const m of planned) {
      try {
        await sendChatMessage(m.dialogId, m.message, t.call, notifyBotId, console.warn)
      } catch (e) {
        // A bare user id can be REFUSED: im.message.add rejects a self-dialog («Вы не можете
        // отправлять сообщения указанному получателю»), and the app's OAuth token sends AS the
        // installing admin — so on the most common portal (one admin, uploads documents himself)
        // the personal failure message was refused on EVERY failure and, with the claim already
        // burnt, lost silently. Fall back to the notification center: im.notify.system.add
        // (scope `im`, already ours) delivers to the token's own user too. Try-then-fallback, not
        // self-detection — it also covers other refusals (fired employee, messaging restrictions).
        const isPersonal = /^\d+$/.test(m.dialogId)
        let recovered = false
        if (isPersonal) {
          try {
            await t.call('im.notify.system.add', { USER_ID: Number(m.dialogId), MESSAGE: m.message })
            recovered = true
          } catch { /* fall through to the warn below */ }
        }
        // One failed address must not swallow the other — but a lost message may not be lost
        // SILENTLY: the claim is once-only, nothing will retry this.
        if (!recovered) console.warn(`[notify] message to ${isPersonal ? 'user' : 'chat'} ${m.dialogId} failed: ${(e as Error)?.message ?? e}`)
      }
    }
  } catch {
    // Best-effort: the person still sees the failure on the app's own screen.
  }
}

/**
 * Absolute link back to the app INSIDE the portal (#385). Built from the portal's own domain — our
 * host cannot open the app the way the portal does (no frame, no frame token).
 *
 * ⚠ Two guards, both found by review of the first version, both about the same thing: the LINK is a
 * nicety, the NOTICE is the point.
 *   1. The read is wrapped — `getToken` throws on any DB trouble, and it runs AFTER the once-only
 *      claim inside an empty `catch`, so a transient Postgres blip meant the employee never learned
 *      the document failed, with no log and no counter. Measured on a fake query that failed only
 *      this statement: zero messages sent, and the retry sent nothing either — the right to speak
 *      was already spent.
 *   2. `backLinkUrl` пропускает чтение, когда личного получателя нет: у `planFailureNotify` ссылку
 *      несёт ТОЛЬКО личное сообщение, и без него запрос к базе не потреблял никто.
 *
 * ⚠ Гейт из п. 2 остаётся именно у `backLinkUrl`, а не у `portalBackLink`: у сообщения в чат ошибок
 * (`buildErrorMessage`) получатель другой — там ссылка нужна независимо от того, известен ли
 * загрузивший (#385). Свалить оба вызова в одну функцию с гейтом значило бы молча выкинуть ссылку
 * из админского сообщения ровно у тех импортов, где id сотрудника не пришёл.
 *
 * ⚠ Адрес требует ДВУХ источников: домен из строки портала и локальный идентификатор приложения из
 * `app.info` (живая находка 09.08.2026 — символьный код Маркета в адресе не работает). Отсюда
 * REST-вызов на пути отказа; он идёт тем же транспортом, что и сама отправка, и его отказ даёт
 * `null`, то есть текст без ссылки, — уведомление важнее ссылки.
 */
async function portalBackLink(memberId: string, infra: LiveInfra, call: RestCall): Promise<string | null> {
  const domain = await getToken(memberId, infra.query).then(t => t?.domain).catch(() => null)
  if (!domain) return null
  return portalAppUrl(domain, await fetchAppId(call))
}

async function backLinkUrl(memberId: string, uploaderId: string | null, infra: LiveInfra, call: RestCall): Promise<string | null> {
  if (!uploaderId) return null
  return portalBackLink(memberId, infra, call)
}

export function liveFileExtractDeps(infra: LiveInfra): FileExtractDeps {
  // ONE resolver for this dep set — the same invariant the crm-sync builder keeps: one client per
  // portal means one rate-limiter bucket and one token load, not a fresh pair per failure.
  const sharedRest = restResolver(infra)
  return {
    // Bytes live at uploadPath(member, job); fileId is the original filename, used
    // only for extension-based format routing (planExtraction).
    extractText: (m, j, fileId) => extractText(uploadPath(m, j), fileId, infra.runners),
    saveText: (m, j, text) => saveText(m, j, text, infra.query),
    enqueueAgentRun: (m, j) => enqueueAgent({ memberId: m, jobId: j }),
    failJob: async (m, j, reason) => {
      await setJobStatus(m, j, 'error', reason, jobRedis)
      await notifyImportFailure(infra, m, j, reason, { rest: sharedRest })
    },
    markExtracting: (m, j) => setJobStatus(m, j, 'extracting', '', jobRedis)
    // ⚠ Архивной копии на Диске БОЛЬШЕ НЕТ (#458, решение владельца): документ вкладывается в
    // само дело таймлайна, поэтому вторая копия по второму адресу — лишнее хранилище чужих
    // документов, которым мы не управляем. Вместе с ней ушли настройка «сохранять исходный файл»
    // и право `disk` в скоупе приложения.
  }
}

/** agent-run deps: agent extraction + doc/text stores + crm-sync enqueue. */
export function liveAgentRunDeps(infra: LiveInfra): AgentRunDeps {
  const instructions = buildExtractionPrompt()
  const sharedRest = restResolver(infra)
  return {
    getDocumentText: (m, j) => getText(m, j, infra.query),
    extractDocument: async (documentText) => {
      const sleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms))
      const random = () => Math.random()
      // OpenAI-compatible extractor (DeepSeek/BitrixGPT). An unset provider key does NOT silently
      // degrade — chatFn is a throwing transport, so the job fails LOUDLY ("provider not configured").
      const r = await runChatExtract({ documentText, instructions, model: infra.llmModel }, { chat: infra.chatFn, sleep, random })
      return { document: r.document, ...(r.error ? { error: r.error } : {}), ...(r.own ? { own: r.own } : {}) }
    },
    saveDocument: (m, j, stored) => saveDocument(m, j, stored, infra.query),
    enqueueCrmSync: (m, j) => enqueueCrmSync({ memberId: m, jobId: j }),
    failJob: async (m, j, reason) => {
      await setJobStatus(m, j, 'error', reason, jobRedis)
      await notifyImportFailure(infra, m, j, reason, { rest: sharedRest })
    },
    // Operator's manual import target (set at upload) → RoutingSignals.manualOverride, which
    // resolveTarget applies with top priority over the routing rules (#135 routing slice 2).
    getManualOverride: (m, j) => getManualOverride(m, j, jobRedis),
    deleteText: (m, j) => deleteText(m, j, infra.query),
    markProcessing: (m, j) => setJobStatus(m, j, 'processing', '', jobRedis),
    // Класс отказа + просеянная подпись — в журнал (#416). Сотрудник видит наш текст, оператор
    // здесь видит, ЧТО именно сломалось: без этой строки «квота кончилась» и «ключ отозвали»
    // выглядели бы в журнале одинаково, а чинятся по-разному.
    logLlmFailure: (kind, signature) => console.warn(`[agent-run] отказ распознавания: ${kind}${signature ? ` (${signature})` : ''}`)
  }
}

/**
 * crm-sync deps bound to one portal+job+mapping (deterministic lookups via portal REST).
 * An unmatched product line is handled per mapping.product.onMissing — `skip-warn` (drop +
 * warning) or `freeform` (write a free-form position). Creating catalog products was removed
 * (too complex an operation for a multitenant import).
 */
/**
 * Пер-джобовые зависимости crm-sync.
 *
 * ⚠ Экспортируется РАДИ ШВА, а не для внешних вызывающих: транспорт (`rest`) и инфраструктуру
 * принимает параметрами, поэтому проводку можно прогнать на фейках. Без экспорта единственный путь
 * сюда — `liveCrmSyncHandlerDeps`, который строит транспорт внутри себя и на тесте полез бы в сеть,
 * то есть проводка осталась бы непроверяемой. Тот же приём, что у `notifyImportFailure` с её
 * инъектируемым `opts.rest` (#385).
 */
export function liveCrmSyncDeps(memberId: string, jobId: string, mapping: PortalMapping, rest: (m: string) => Promise<SdkTransport | null>, infra: LiveInfra): CrmSyncDeps {
  const need = async (): Promise<SdkTransport> => {
    const t = await rest(memberId)
    if (!t) throw new Error('портал не авторизован (нет токена)')
    return t
  }
  // #316: id of the portal's chat bot so notices are signed by the app, not by the employee whose
  // token we hold. Resolved lazily and at most once per job; a portal that cannot have a bot
  // (free plan, bot limit, installed before the `imbot` scope) answers 0 and keeps the old path.
  let botIdMemo: number | null = null
  const botId = async (): Promise<number> => {
    if (botIdMemo !== null) return botIdMemo
    // Reuse the job's transport instead of resolving a second one — same portal, same client.
    botIdMemo = await resolvePortalBotId(memberId, infra, async () => (await need()).call)
    return botIdMemo
  }
  // Адрес приложения на портале — мемо на джобу, тем же приёмом, что `botId` выше.
  //
  // ⚠ Мемо не украшение: на одном отказе адрес нужен ДВАЖДЫ — личному сообщению сотруднику
  // (через `notifyImportFailure`) и сообщению в чат ошибок, — а каждый вызов читает строку портала
  // из Postgres. Без мемо правка #385 добавляла второй SELECT на каждый отказ, ничего им не узнавая:
  // домен один и тот же, портал тот же, обработка та же. `undefined` — «ещё не спрашивали»,
  // `null` — «спросили, адреса нет» (домена нет или чтение упало); второе тоже кэшируется, иначе
  // мёртвая база опрашивалась бы повторно ровно тогда, когда она мертва.
  let appUrlMemo: string | null | undefined
  const appUrl = async (): Promise<string | null> => {
    if (appUrlMemo === undefined) appUrlMemo = await portalBackLink(memberId, infra, (await need()).call)
    return appUrlMemo
  }
  // Auto-create measure state (Q11): the portal's existing measures indexed once per job — codes
  // (seed the allocator) + title/symbol → code (FIND-before-create, so a unit already in the catalog
  // is reused not duplicated; also makes a job retry idempotent). Best-effort: a list failure yields
  // an EMPTY index (createMeasure then degrades to null → default), never fails the job.
  let measureIndex: MeasureIndex | null = null
  let measuresCreated = 0 // distinct auto-creates this job (anti-flood cap)
  // `false` = the list call failed. Kept DISTINCT from an empty index: «catalogue unreadable» and
  // «catalogue read, code absent» must lead to different decisions for the built-in unit map (#272).
  let measureIndexFailed = false
  const loadMeasureIndex = async (): Promise<MeasureIndex | null> => {
    if (!measureIndex && !measureIndexFailed) {
      try {
        measureIndex = buildMeasureIndex(await fetchMeasureRows((await need()).call))
      } catch {
        measureIndexFailed = true
      }
    }
    return measureIndex
  }
  const ensureMeasureIndex = async (): Promise<MeasureIndex> =>
    (await loadMeasureIndex()) ?? { codes: [], byName: new Map() }
  // Инфоблоки каталога — резолвятся ОДИН раз на задание и передаются в каждый findProduct.
  // ⚠ Нужны ОБА, а не только предложения: методы `catalog.*` (пришли на смену deprecated
  // `crm.product.*`) требуют `iblockId` в фильтре, поэтому без инфоблока товаров базовый подбор
  // не может сделать ни одного запроса. Fail-soft: нечитаемый каталог / нет подписки → оба `null`
  // → подбора не будет, но импорт пройдёт свободными строками, а не упадёт. Мемо (undefined = ещё
  // не резолвили), иначе `catalog.catalog.list` дёргался бы на каждую позицию.
  let iblocks: CatalogIblocks | undefined
  const ensureIblocks = async (): Promise<CatalogIblocks> => {
    if (iblocks === undefined) {
      try {
        iblocks = await resolveIblocks((await need()).call)
      } catch {
        iblocks = NO_IBLOCKS
      }
    }
    return iblocks
  }
  // Portal CRM mode — resolved ONCE per job. In the SIMPLE CRM (no leads) a lead target is redirected to
  // a deal (crmSyncCore). Fail-open: an unreadable mode keeps leads enabled.
  let crmMode: number | null | undefined
  const ensureLeadsEnabled = async (): Promise<boolean> => {
    if (crmMode === undefined) {
      try {
        crmMode = await fetchCrmMode((await need()).call)
      } catch {
        crmMode = null
      }
    }
    return leadsEnabled(crmMode)
  }
  return {
    // One-time finalize claim (#164): the run that wins flips import_job.notified false→true, so
    // the success chat + timeline дело fire exactly once even when a retry resumes after a
    // post-create failure. Atomic UPDATE → race-safe against a concurrent stalled redelivery.
    claimFinalize: () => claimJobNotify(memberId, jobId, jobRedis),
    // Idempotency by B24 marker search (originId/xmlId) — no local checkpoint. The originator
    // code (env, defaults to the repo code) namespaces our marker so it never matches a portal's
    // own external-source data.
    findExisting: async (entityTypeId, filter) => findExistingItemId(entityTypeId, filter, (await need()).call),
    originatorPrefix: process.env.IMPORT_ORIGINATOR_ID,
    findCompanyByTaxId: async taxId => findCompanyByTaxId(taxId, (await need()).call),
    findProduct: async item => findProduct(item, mapping, (await need()).call, await ensureIblocks()),
    // Auto-create measure (opt-in): wired only when enabled so crm-sync's presence check gates it.
    // Find-before-create against the portal index (reuse → {created:false}); otherwise allocate +
    // create (→ {created:true}), pushing the new code into the index so repeats/later units reuse it.
    // Capped per job (anti-flood). null → caller uses the default code.
    createMeasure: mapping.units.autoCreate
      ? async (unit) => {
        const idx = await ensureMeasureIndex()
        const existing = lookupExistingMeasure(unit, idx)
        if (existing !== null) return { code: existing, created: false }
        if (measuresCreated >= MAX_AUTO_MEASURES_PER_JOB) return null // anti-flood cap reached
        const code = await createMeasureViaRest(unit, idx.codes, (await need()).call)
        if (code === null) return null
        idx.codes.push(code)
        idx.byName.set(normalizeUnitKey(unit), code) // reuse on repeat / retry
        measuresCreated += 1
        return { code, created: true }
      }
      : undefined,
    // The portal's REAL measure catalogue, loaded once per job (not gated on autoCreate). crm-sync
    // needs it because the built-in synonym map yields a standard ОКЕИ code that a given portal may
    // not have — a fresh portal ships only a handful of measures, and writing an absent code would
    // put a silently wrong unit on the row. `null` = the list call failed (caller decides).
    measureCatalog: async () => {
      const idx = await loadMeasureIndex()
      if (!idx) return null
      const codes = new Set(idx.codes)
      return {
        hasCode: (code: number) => codes.has(code),
        byName: (unit: string) => lookupExistingMeasure(unit, idx)
      }
    },
    // VAT rates: full-list fetch via the SDK's built-in pagination (SdkListCall).
    portalVatRates: async () => fetchVatRates((await need()).list),
    portalCurrencies: async () => fetchCurrencies((await need()).call),
    // Valid funnel ids for an entity type → crm-sync falls back off a DELETED direction
    // (rule/default → deal/direction-0). One crm.category.list only when a target pins a categoryId.
    listCategoryIds: async entityTypeId => (await fetchCrmCategories(entityTypeId, (await need()).call)).map(c => c.id),
    leadsEnabled: ensureLeadsEnabled,
    createTarget: async (target, fields) => createTargetItem(target, fields, (await need()).call),
    setRows: async (etid, id, rows) => setProductRows(etid, id, rows, (await need()).call),
    reportErrors: async (messages, supplierName) => {
      if (!messages.length) return
      await bumpCounter(memberId, METRICS.errors, 1, infra.query)
      // The uploader hears about it too — but NOT a second error-chat message: this branch posts
      // its own below, and the same failure twice in one chat reads as two failures.
      // All the reasons, not just the first: a document can miss both a currency and a VAT rate,
      // and telling the person one of them makes them fix it, re-upload and fail again on the other.
      // Reuses the resolver + mapping already resolved for this job (one client, one token load).
      // `appUrl` передаём уже разрешённым: то же значение нужно сообщению в чат ошибок ниже, и без
      // передачи строка портала читалась бы из Postgres дважды на один отказ (#385).
      await notifyImportFailure(infra, memberId, jobId, messages.join('; ') || 'документ не удалось внести в CRM', { alsoErrorChat: false, rest, mapping, appUrl: await appUrl() })
      // Deliver to the error chat (im.message.add, BB-neutralised). Best-effort:
      // a chat failure must not mask the underlying import error.
      // Claimed once per job, and only AFTER a transport exists — a redelivered job must not post
      // the same failure twice, and a missing token must not burn the right to post it at all.
      if (mapping.errorChatId) {
        try {
          const t = await rest(memberId)
          if (t && await claimJobErrorChat(memberId, jobId, jobRedis)) {
            // Хвост сообщения (#385): идентификатор задания — чтобы админ вообще мог найти этот
            // импорт, ссылка — чтобы из чата был путь в приложение. Соседнее сообщение об отказе
            // (`planFailureNotify`) несло `Задание:` всегда, это — не несло ничего.
            await sendChatMessage(
              mapping.errorChatId,
              buildErrorMessage(supplierName, messages, { jobId, appUrl: await appUrl() }),
              t.call,
              await botId(),
              console.warn
            )
          }
        } catch { /* swallow — dashboard counter already bumped */ }
      }
    },
    notifySuccess: async (summary) => {
      if (!mapping.notifyChatId) return
      const t = await need()
      // Portal host → an absolute clickable BB-link «Открыть в CRM» in the chat message (a bare
      // path is not a link). No host ⇒ the link line is omitted entirely (#385) — a relative URL
      // has no base in the desktop and mobile clients, so it would be a dead link, not a fallback.
      const domain = (await getToken(memberId, infra.query))?.domain
      await sendChatMessage(mapping.notifyChatId, buildSuccessMessage(summary, domain), t.call, await botId(), console.warn)
    },
    // Дело таймлайна — УНИВЕРСАЛЬНОЕ (`crm.activity.todo.add`, #328). Конфигурируемое ушло вместе
    // с Диском: оно не носит файлов, поэтому документ жил отдельной копией на Диске, а дело —
    // ссылкой на неё. Теперь документ ВЛОЖЕН в само дело, и копия ровно одна.
    //
    // МОДЕЛЬ ВЛАДЕЛЬЦА (не изменилась, проверена живьём и на новом носителе): у дела ОДИН владелец
    // (`ownerTypeId`/`ownerId` — карточка, где оно физически лежит), всё остальное — привязки через
    // `crm.activity.binding.add`.
    //   • контрагент найден → владелец КОМПАНИЯ, + привязка к созданной сущности;
    //   • не найден         → владелец сама сущность (привязывать нечего).
    // Пишется РОВНО ОДНО дело и видно оно в обоих таймлайнах. Best-effort: runCrmSync глотает сбои.
    writeActivity: async ({ entityTypeId, entityId, companyId, supplierName, rowCount, matchedCount, amountLabel, warnings, advice }) => {
      const call = (await need()).call
      const hasCompany = !!companyId && companyId > 0
      // Вход дела собирает ЧИСТАЯ функция (`buildActivityInput`): здесь её было не достать тестом,
      // и подмена признака «чистый импорт» дублирующим ключом проходила при зелёных проверках.
      // ⚠ Ответственный — ТОТ, КТО ЗАГРУЗИЛ документ (решение владельца 06.08.2026), а не владелец
      // токена. Без этого дело доставалось администратору, чьим OAuth-токеном работает
      // приложение: у него в списке дел копились чужие импорты, а человек, загрузивший накладную,
      // своего дела не видел вовсе — то есть напоминание о замечаниях приходило не тому.
      // ⚠ Id сотрудника не узнали (задание пришло повторной доставкой, запись истекла) ⇒ поле НЕ
      // ставим: портал подставит владельца токена, и это по-прежнему лучше, чем несуществующий id,
      // на котором вызов отвергается целиком и дела не будет вовсе.
      const uploader = Number(await getUploaderId(memberId, jobId, jobRedis))
      const input = buildActivityInput({
        entityTypeId,
        entityId,
        companyId,
        supplierName,
        rowCount,
        matchedCount,
        amountLabel,
        warnings,
        advice,
        nowMs: Date.now(),
        ...(Number.isInteger(uploader) && uploader > 0 ? { responsibleId: uploader } : {})
      })
      const res = await call('crm.activity.todo.add', buildTodoActivity(input)) as { id?: number } | number | undefined
      const activityId = Number((res as { id?: number })?.id ?? res)
      if (!Number.isFinite(activityId) || activityId <= 0) return

      // ⚠ Разметка включается ОТДЕЛЬНЫМ вызовом: у `todo.add` параметра под тип описания нет, а
      // дефолт `2` (HTML) показал бы BB-код исходником — человек читал бы «[B]Поставщик:[/B]»
      // буквально в КАЖДОМ деле. Отдельный вызов best-effort: без него дело всё равно ценнее,
      // чем его отсутствие.
      // Тем же вызовом ставится МАРКЕР приложения (`ORIGINATOR_ID`/`ORIGIN_ID`) — по нему экран
      // журнала находит свои дела, а повторная доставка задания находит СВОЁ дело вместо того,
      // чтобы завести второе. Оба поля у `todo.add` отсутствуют, только `update`.
      try {
        await call('crm.activity.update', {
          id: activityId,
          fields: buildActivityMarkerFields(originatorCode(process.env.IMPORT_ORIGINATOR_ID), jobId)
        })
      } catch (e) {
        console.warn('[crm-sync] дело осталось без разметки и маркера; job', jobId, '-', (e as { message?: string })?.message ?? e)
      }

      // ⚠ РАЗМЕР ПРОВЕРЕН ЖИВЬЁМ 08.08.2026 (лестницей 1/5/10/15/20 МБ на портале b24-hrbvzq):
      // предела тела у REST нет, вложение доехало на всех, включая наш максимум загрузки. Но время
      // растёт нелинейно и на 20 МБ составило 22 с при таймауте SDK в 30 с — то есть запас
      // меньше трети. На медленном канале или загруженном портале такой документ упрётся в
      // таймаут, вложение молча не появится (путь best-effort), а в журнале останется строка
      // «вложить файл не удалось». Поднимать таймаут не стали: 30 с уже на границе того, сколько
      // разумно держать задачу очереди, а документы такого размера — единичные сканы.
      //
      // Исходный документ ВЛОЖЕНИЕМ. Байты берём из загрузки задания — они живут до конца crm-sync
      // (#458, решение владельца): раньше файл удалялся сразу после извлечения текста, и на этой
      // стадии вкладывать было уже нечего. Единственная принимаемая порталом форма — `fileData`
      // (#328); привязать по id файл, лежащий на Диске, по REST нельзя нигде.
      // Best-effort: дело без вложения полезнее отсутствующего дела.
      try {
        const bytes = await readUploadBytes(memberId, jobId)
        if (bytes) {
          const fileName = (await getJob(memberId, jobId, jobRedis))?.fileName || 'документ'
          await call('crm.activity.update', {
            id: activityId,
            fields: buildFileAttachment(fileName, Buffer.from(bytes).toString('base64'))
          })
        } else {
          // Не молчим: без файла дело выглядит нормальным, и пропажу вложения иначе пришлось бы
          // ловить руками — ровно тот дефект, что чинили в #263 у ссылки на архив.
          console.warn('[crm-sync] исходный файл недоступен — дело записано без вложения; job', jobId, 'portal', portalHash(memberId))
        }
      } catch (e) {
        console.warn('[crm-sync] вложить файл в дело не удалось; job', jobId, '-', (e as { message?: string })?.message ?? e)
      }

      // Чистый импорт — дело ЗАКРЫВАЕМ. Отдельным вызовом, потому что `todo.add` создаёт дело
      // только открытым: параметра «создать завершённым» у метода нет.
      if (input.clean) {
        try {
          await call('crm.activity.update', { id: activityId, fields: { COMPLETED: 'Y' } })
        } catch (e) {
          console.warn('[crm-sync] дело не закрылось; job', jobId, '-', (e as { message?: string })?.message ?? e)
        }
      }

      // Привязка к созданной сущности, чтобы ОДНО дело было видно и в таймлайне компании, и в
      // таймлайне сущности (`crm.activity.binding.add` — проверено живьём и на универсальном деле).
      if (hasCompany) {
        try {
          await call('crm.activity.binding.add', { activityId, entityTypeId, entityId })
        } catch (e) {
          // Best-effort: дело уже в таймлайне компании. Но пишем в лог — без привязки его НЕ будет
          // видно в карточке сделки, куда менеджер и смотрит.
          console.warn(`[crm-sync] activity binding failed (activity ${activityId} → entity ${entityTypeId}:${entityId}):`, (e as { message?: string })?.message ?? e)
        }
      }
    }
  }
}

/**
 * Байты загруженного документа для вложения в дело (#458).
 *
 * ⚠ Файл теперь живёт до КОНЦА crm-sync, а не до конца извлечения текста: дело создаётся именно
 * здесь, и при прежнем сроке вкладывать было бы уже нечего. Срок вырос с «секунды» до
 * «секунды-минуты» — это записано в Политике, а не подразумевается.
 * ⚠ Отсутствие файла — НЕ ошибка: задание могло прийти повторной доставкой уже после уборки.
 * Возвращаем `null`, а зовущий пишет об этом в журнал.
 */
async function readUploadBytes(memberId: string, jobId: string): Promise<Uint8Array | null> {
  const { readFile } = await import('node:fs/promises')
  const { uploadPath } = await import('../utils/fileStore')
  return await readFile(uploadPath(memberId, jobId)).catch(() => null)
}

/** crm-sync handler deps: mapping + stored doc + per-job crm deps + status + cleanup. */
export function liveCrmSyncHandlerDeps(infra: LiveInfra): HandlerDeps {
  const rest = restResolver(infra)
  return {
    getMapping: m => loadMapping(m, rest),
    getDocument: (m, j) => getDocument(m, j, infra.query),
    crmSyncDeps: (m, j, mapping) => liveCrmSyncDeps(m, j, mapping, rest, infra),
    setJobStatus: (m, j, status, result) => setJobStatus(m, j, status, result, jobRedis),
    // crm-sync can end 'error' WITHOUT throwing (the stored document is gone), so BullMQ's
    // exhausted-retries hook never runs — announce it here or nowhere (BACKLOG.md §1).
    failJob: async (m, j, reason) => {
      await setJobStatus(m, j, 'error', reason, jobRedis)
      await notifyImportFailure(infra, m, j, reason, { rest })
    },
    deleteDocument: (m, j) => deleteDocument(m, j, infra.query),
    bumpMetrics: async (m, deltas) => {
      for (const [name, by] of Object.entries(deltas)) await bumpCounter(m, name, by, infra.query)
    }
  }
}
