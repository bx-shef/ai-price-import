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
import { claimJobErrorChat, claimJobFailNotify, claimJobNotify, getDiskFileUrl, getJob, getManualOverride, getUploaderId, setDiskFile, setJobStatus, shouldWarnMissingArchive } from '../utils/jobStore'
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
import { resolveOffersIblockId } from '../utils/offerLookup'
import { fetchMeasureRows } from '../utils/measureList'
import { createMeasureViaRest } from '../utils/measureCreateWrite'
import { buildMeasureIndex, lookupExistingMeasure, normalizeUnitKey, MAX_AUTO_MEASURES_PER_JOB, type MeasureIndex } from '~/utils/measureCreate'
import { fetchVatRates } from '../utils/portalVat'
import { fetchCurrencies } from '../utils/portalCurrency'
import { createTargetItem, setProductRows } from '../utils/crmWrite'
import { buildConfigurableActivity, entityOpenPath, COMPANY_ENTITY_TYPE_ID } from '../utils/configurableActivity'
import { buildErrorMessage, buildSuccessMessage, sendChatMessage } from '../utils/chatNotify'
import { planFailureNotify } from '../utils/failureNotify'
import { extractText } from '../utils/textExtract'
import { readFile } from 'node:fs/promises'
import { uploadPath } from '../utils/fileStore'
import { makeSaveSourceFile } from '../utils/disk'
import { portalHash } from '../utils/telemetryAttributes'
import { runChatExtract, type ChatFn } from '../agent/chatExtract'
import { buildExtractionPrompt } from '../../prompts/extract'
import { enqueueAgent, enqueueCrmSync } from './producers'
import type { AgentRunDeps, EventHandlerDeps, FileExtractDeps, HandlerDeps } from './handlers'
import { eventJobToSaveInput } from './topology'
import type { CrmSyncDeps } from './crmSyncCore'
import type { PortalMapping } from '~/types/mapping'
import { portalAppUrl } from '~/config/b24'
import { LANDING_MARKET_CODE } from '~/utils/landing'

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

/**
 * Register the portal's bot and push the app's profile onto it (#316/#360).
 *
 * The profile push is NOT redundant with registration: `Bot.register` is idempotent and overwrites
 * nothing, so a portal that already has the bot would keep whatever name it was first given —
 * a rename (or, later, an avatar) would never reach it. Best-effort throughout: a portal that
 * cannot have a bot must still install.
 */
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
  opts: { alsoErrorChat?: boolean, rest?: (m: string) => Promise<SdkTransport | null>, mapping?: PortalMapping } = {}
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
      appUrl: await backLinkUrl(memberId, uploaderId, infra)
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
 *   2. It is skipped when there is no personal recipient: only the personal message carries the
 *      link (the error chat gets a job id), so reading the portal row for the other branch was a
 *      query per notification that nothing consumed.
 */
async function backLinkUrl(memberId: string, uploaderId: string | null, infra: LiveInfra): Promise<string | null> {
  if (!uploaderId) return null
  const domain = await getToken(memberId, infra.query).then(t => t?.domain).catch(() => null)
  return portalAppUrl(domain, LANDING_MARKET_CODE)
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
    markExtracting: (m, j) => setJobStatus(m, j, 'extracting', '', jobRedis),
    // Archive the source file to the portal's common Disk when `saveFile` is on. One transport
    // is resolved and shared by the mapping read and the Disk upload (no double token-load); the
    // raw bytes come from the upload dir (this is the last stage where they exist). A Disk hiccup
    // is swallowed by the handler — the import proceeds.
    saveSourceFile: makeSaveSourceFile({
      resolveCall: sharedRest,
      // Настройки не прочитались ⇒ архивирование НЕ делаем (#373, ревью): `saveFile` включён по
      // умолчанию, поэтому обычный фолбэк на дефолты скопировал бы документ клиента на Диск портала
      // как раз тогда, когда мы не знаем, не выключил ли админ это сам. Архив best-effort — его
      // пропуск не роняет импорт, а лишняя копия чужого документа необратима.
      loadMapping: call => readMapping(call).catch(() => ({ ...defaultMapping(), saveFile: false })),
      readBytes: (m, j) => readFile(uploadPath(m, j)),
      // Serialize the Disk write per portal so concurrent scale-out workers don't duplicate the
      // shared app/month folders (B24 Disk has no atomic create-if-absent). Same primitive as the
      // token-refresh path (#35); the lock ignores the injected QueryFn (no DB work in the archive).
      serialize: (key, fn) => withAdvisoryLock(key, () => fn()),
      // Persist the archived file ref so crm-sync can link it on the timeline дело (#129 follow-up).
      recordDiskFile: (m, j, ref) => setDiskFile(m, j, ref, jobRedis),
      now: infra.now
    })
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
      return { document: r.document, ...(r.error ? { error: r.error } : {}) }
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
    markProcessing: (m, j) => setJobStatus(m, j, 'processing', '', jobRedis)
  }
}

/**
 * crm-sync deps bound to one portal+job+mapping (deterministic lookups via portal REST).
 * An unmatched product line is handled per mapping.product.onMissing — `skip-warn` (drop +
 * warning) or `freeform` (write a free-form position). Creating catalog products was removed
 * (too complex an operation for a multitenant import).
 */
function liveCrmSyncDeps(memberId: string, jobId: string, mapping: PortalMapping, rest: (m: string) => Promise<SdkTransport | null>, infra: LiveInfra): CrmSyncDeps {
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
  // Offers (SKU / ТП) iblock — resolved ONCE per job, then passed to every findProduct so offers get
  // priority over the base product. Fail-soft: no offers catalog / no catalog subscription → null →
  // findProduct just does the base-product lookup (the pre-offer behaviour). Memoized (undefined = not
  // yet resolved) so a portal without offers doesn't re-query catalog.catalog.list on every line.
  let offersIblockId: number | null | undefined
  const ensureOffersIblock = async (): Promise<number | null> => {
    if (offersIblockId === undefined) {
      try {
        offersIblockId = await resolveOffersIblockId((await need()).call)
      } catch {
        offersIblockId = null
      }
    }
    return offersIblockId
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
    findProduct: async item => findProduct(item, mapping, (await need()).call, await ensureOffersIblock()),
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
      await notifyImportFailure(infra, memberId, jobId, messages.join('; ') || 'документ не удалось внести в CRM', { alsoErrorChat: false, rest, mapping })
      // Deliver to the error chat (im.message.add, BB-neutralised). Best-effort:
      // a chat failure must not mask the underlying import error.
      // Claimed once per job, and only AFTER a transport exists — a redelivered job must not post
      // the same failure twice, and a missing token must not burn the right to post it at all.
      if (mapping.errorChatId) {
        try {
          const t = await rest(memberId)
          if (t && await claimJobErrorChat(memberId, jobId, jobRedis)) {
            await sendChatMessage(mapping.errorChatId, buildErrorMessage(supplierName, messages), t.call, await botId(), console.warn)
          }
        } catch { /* swallow — dashboard counter already bumped */ }
      }
    },
    notifySuccess: async (summary) => {
      if (!mapping.notifyChatId) return
      const t = await need()
      // Portal host → an absolute clickable BB-link «Открыть в CRM» in the chat message
      // (a bare path is not a link). Best-effort: no token row ⇒ relative fallback.
      const domain = (await getToken(memberId, infra.query))?.domain
      await sendChatMessage(mapping.notifyChatId, buildSuccessMessage(summary, domain), t.call, await botId(), console.warn)
    },
    // Configurable timeline activity (crm.activity.configurable.add, OAuth app context — verified live).
    // OWNER MODEL (owner ask, live-verified): a дело has ONE owner (ownerTypeId/ownerId — where it
    // physically lives); every other entity is an ADDITIONAL binding via crm.activity.binding.add.
    //   • company matched → owner = COMPANY, +binding to the created entity (deal/lead/invoice/СПА);
    //   • no company      → owner = the created entity (nothing else to bind).
    // So exactly ONE activity is written (was two) and it shows in BOTH timelines via the binding.
    // Best-effort; runCrmSync swallows failures.
    writeActivity: async ({ entityTypeId, entityId, companyId, supplierName, rowCount, warnings }) => {
      // Link the archived source file on the дело when it was saved to the Disk (#129 follow-up).
      // Best-effort — a lookup failure just omits the button, never fails the import.
      // A read failure here used to be fully silent (`.catch(() => null)`), so a missing «Исходный
      // файл» button left no trace anywhere — it had to be caught by hand (#263). Still best-effort,
      // but now loud in the log. `null` without a throw is normal (saveFile off / not archived yet).
      const sourceFileUrl = await getDiskFileUrl(memberId, jobId, jobRedis).catch((e: unknown) => {
        console.warn('[crm-sync] source file link unavailable for job', jobId, '-', e instanceof Error ? e.message : String(e))
        return null
      })
      // Archiving is ON but no link: the дело is about to be written without the «Исходный файл»
      // button, and until now that vanished without a trace anywhere (#263). Decision is a pure,
      // tested predicate — see shouldWarnMissingArchive for why the wording names no cause.
      if (shouldWarnMissingArchive(mapping.saveFile, sourceFileUrl)) {
        console.warn('[crm-sync] saveFile is on but no archive link — дело written without the «Исходный файл» button; job', jobId, 'portal', portalHash(memberId))
      }
      // Record import PROBLEMS on the timeline дело (owner ask) so the operator sees what needed
      // attention — товар не найден / единица / НДС уточнён / итог не сошёлся. Capped so the body
      // stays within B24's block limit (buildConfigurableActivity slices to 10 total).
      const problems = warnings.length
        ? [`Проблемы (${warnings.length}):`, ...warnings.slice(0, 6).map(w => `• ${w}`)]
        : []
      const lines = [`Позиций: ${rowCount}`, ...(supplierName ? [`Поставщик: ${supplierName}`] : []), ...problems]
      const title = `Импорт: ${supplierName ?? 'документ'}`
      const hasCompany = !!companyId && companyId > 0
      const call = (await need()).call
      // ONE дело. Owner = the client company when matched (its card is the natural home), else the
      // created entity. «Открыть» jumps to the created entity from the company timeline; with no company
      // the owner IS the entity → no button (nothing else to open).
      const res = await call('crm.activity.configurable.add', buildConfigurableActivity({
        ownerTypeId: hasCompany ? COMPANY_ENTITY_TYPE_ID : entityTypeId,
        ownerId: hasCompany ? companyId! : entityId,
        title,
        lines,
        openPath: entityOpenPath(entityTypeId, entityId),
        showOpenButton: hasCompany,
        // Имя файла — подпись ссылки в деле (#328). Берём из задания; нет — билдер подставит
        // нейтральное «Открыть файл».
        ...(sourceFileUrl ? { sourceFileUrl, sourceFileName: (await getJob(memberId, jobId, jobRedis))?.fileName ?? '' } : {})
      })) as { activity?: { id?: number } } | undefined
      // Additional binding to the created entity so the SAME дело shows on both the company AND the
      // entity timeline (crm.activity.binding.add — live-verified with a configurable activity). Best-
      // effort: the дело is already on the company timeline; a binding failure (or already-bound) is fine.
      const activityId = res?.activity?.id
      if (hasCompany && activityId) {
        try {
          await call('crm.activity.binding.add', { activityId, entityTypeId, entityId })
        } catch (e) {
          // Best-effort: the дело is on the company timeline regardless. But log it (not silent) — a
          // binding failure means the дело WON'T show on the entity (deal/…) timeline, where the manager
          // usually looks. The withDependencySpan wrapper records the REST error separately; this warn
          // makes it visible in plain logs too.
          console.warn(`[crm-sync] activity binding failed (activity ${activityId} → entity ${entityTypeId}:${entityId}):`, (e as { message?: string })?.message ?? e)
        }
      }
    }
  }
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
