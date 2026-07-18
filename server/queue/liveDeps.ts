import type { QueryFn } from '../utils/tokenStore'
import type { AgentSpawn } from '../agent/runAgent'
import type { ExtractRunners } from '../utils/textExtract'
import type { EnsureDeps } from '../utils/ensureAccessToken'
import { ensureFreshToken } from '../utils/ensureAccessToken'
import { selectTokensNearExpiry, type KeepAliveDeps } from '../utils/tokenKeepAlive'
import { deletePortal, getToken, saveToken, updateTokensOnRefresh } from '../utils/tokenStore'
import { withAdvisoryLock } from '../utils/dbLock'
import { createPortalSdkResolver, makePortalSdkCall, sdkPortalDeps, sdkRefreshTransport, type PortalSdkResolver, type SdkTransport } from '../utils/b24Sdk'
import { purgePortalFiles } from '../utils/nodeFileIO'
import { decryptSecret, encryptSecret } from '../utils/secretCrypto'
import { claimJobNotify, getManualOverride, setJobStatus } from '../utils/jobStore'
import { getText, saveText, deleteText } from '../utils/textStore'
import { getDocument, saveDocument, deleteDocument } from '../utils/docStore'
import { findExistingItemId } from '../utils/originLookup'
import { bumpCounter, METRICS } from '../utils/metricsStore'
import { readMapping } from '../utils/appSettings'
import { defaultMapping } from '~/utils/portalSettings'
import { findCompanyByTaxId } from '../utils/companyLookup'
import { findProduct } from '../utils/productLookup'
import { createProductViaRest } from '../utils/productCreate'
import { fetchVatRates } from '../utils/portalVat'
import { fetchCurrencies } from '../utils/portalCurrency'
import { createTargetItem, setProductRows } from '../utils/crmWrite'
import { buildConfigurableActivity, entityOpenPath } from '../utils/configurableActivity'
import { buildErrorMessage, buildSuccessMessage, sendChatMessage } from '../utils/chatNotify'
import { extractText } from '../utils/textExtract'
import { readFile } from 'node:fs/promises'
import { uploadPath } from '../utils/fileStore'
import { makeSaveSourceFile } from '../utils/disk'
import { runAgent } from '../agent/runAgent'
import { buildExtractionPrompt } from '../../prompts/extract'
import { enqueueAgent, enqueueCrmSync } from './producers'
import type { AgentRunDeps, EventHandlerDeps, FileExtractDeps, HandlerDeps } from './handlers'
import { eventJobToSaveInput } from './topology'
import type { CrmSyncDeps } from './crmSyncCore'
import type { PortalMapping } from '~/types/mapping'

// Live wiring: bind the pure handlers' DI to real stores / portal REST / agent / queues.
// Subprocess-heavy transports (agent spawn, file extract runners) and the OAuth refresh
// HTTP are INJECTED via LiveInfra so this module stays free of untestable globals and
// typecheck validates every binding. See docs/redesign 02 §4.

export interface LiveInfra {
  query: QueryFn
  /** AES key (base64) for refresh-token decrypt/encrypt. */
  encKey: string
  clientId: string
  clientSecret: string
  now: () => number
  /** Live agent runner (sanitized env + timeout) — server/agent/spawn.makeAgentSpawn. */
  agentSpawn: AgentSpawn
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

/** Load the portal mapping via server-side REST (falls back to defaults). */
async function loadMapping(memberId: string, rest: (m: string) => Promise<SdkTransport | null>): Promise<PortalMapping> {
  const t = await rest(memberId)
  if (!t) return defaultMapping()
  try {
    return await readMapping(t.call)
  } catch {
    return defaultMapping()
  }
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
export function liveEventDeps(infra: LiveInfra): EventHandlerDeps {
  return {
    savePortal: job => saveToken(eventJobToSaveInput(job), infra.query, job.ts),
    deletePortal: (m, ts) => deletePortal(m, infra.query, ts),
    purgeFiles: m => purgePortalFiles(m)
  }
}

/** file-extract deps: real extract runners + text store + queue + status. */
export function liveFileExtractDeps(infra: LiveInfra): FileExtractDeps {
  return {
    // Bytes live at uploadPath(member, job); fileId is the original filename, used
    // only for extension-based format routing (planExtraction).
    extractText: (m, j, fileId) => extractText(uploadPath(m, j), fileId, infra.runners),
    saveText: (m, j, text) => saveText(m, j, text, infra.query),
    enqueueAgentRun: (m, j) => enqueueAgent({ memberId: m, jobId: j }),
    failJob: (m, j, reason) => setJobStatus(m, j, 'error', reason, infra.query),
    markExtracting: (m, j) => setJobStatus(m, j, 'extracting', '', infra.query),
    // Archive the source file to the portal's common Disk when `saveFile` is on. One transport
    // is resolved and shared by the mapping read and the Disk upload (no double token-load); the
    // raw bytes come from the upload dir (this is the last stage where they exist). A Disk hiccup
    // is swallowed by the handler — the import proceeds.
    saveSourceFile: makeSaveSourceFile({
      resolveCall: restResolver(infra),
      loadMapping: call => readMapping(call).catch(() => defaultMapping()),
      readBytes: (m, j) => readFile(uploadPath(m, j)),
      // Serialize the Disk write per portal so concurrent scale-out workers don't duplicate the
      // shared app/month folders (B24 Disk has no atomic create-if-absent). Same primitive as the
      // token-refresh path (#35); the lock ignores the injected QueryFn (no DB work in the archive).
      serialize: (key, fn) => withAdvisoryLock(key, () => fn()),
      now: infra.now
    })
  }
}

/** agent-run deps: agent extraction + doc/text stores + crm-sync enqueue. */
export function liveAgentRunDeps(infra: LiveInfra): AgentRunDeps {
  const instructions = buildExtractionPrompt()
  return {
    getDocumentText: (m, j) => getText(m, j, infra.query),
    extractDocument: async (documentText) => {
      const r = await runAgent(
        { documentText, instructions },
        { spawn: infra.agentSpawn, sleep: ms => new Promise(res => setTimeout(res, ms)), random: () => Math.random() }
      )
      return { document: r.document, ...(r.error ? { error: r.error } : {}) }
    },
    saveDocument: (m, j, stored) => saveDocument(m, j, stored, infra.query),
    enqueueCrmSync: (m, j) => enqueueCrmSync({ memberId: m, jobId: j }),
    failJob: (m, j, reason) => setJobStatus(m, j, 'error', reason, infra.query),
    // Operator's manual import target (set at upload) → RoutingSignals.manualOverride, which
    // resolveTarget applies with top priority over the routing rules (#135 routing slice 2).
    getManualOverride: (m, j) => getManualOverride(m, j, infra.query),
    deleteText: (m, j) => deleteText(m, j, infra.query),
    markProcessing: (m, j) => setJobStatus(m, j, 'processing', '', infra.query)
  }
}

/**
 * crm-sync deps bound to one portal+job+mapping (deterministic lookups via portal REST).
 * `createProduct` (mapping.product.onMissing === 'create') creates a catalog product via
 * crm.product.add and, when matching by article, writes the supplier-article property so
 * the product is re-found next import (no duplicate). Returns null on failure ⇒ runCrmSync
 * degrades to a freeform line + a warning (never silent).
 */
function liveCrmSyncDeps(memberId: string, jobId: string, mapping: PortalMapping, rest: (m: string) => Promise<SdkTransport | null>, infra: LiveInfra): CrmSyncDeps {
  const need = async (): Promise<SdkTransport> => {
    const t = await rest(memberId)
    if (!t) throw new Error('портал не авторизован (нет токена)')
    return t
  }
  return {
    // One-time finalize claim (#164): the run that wins flips import_job.notified false→true, so
    // the success chat + timeline дело fire exactly once even when a retry resumes after a
    // post-create failure. Atomic UPDATE → race-safe against a concurrent stalled redelivery.
    claimFinalize: () => claimJobNotify(memberId, jobId, infra.query),
    // Idempotency by B24 marker search (originId/xmlId) — no local checkpoint. The originator
    // code (env, defaults to the repo code) namespaces our marker so it never matches a portal's
    // own external-source data.
    findExisting: async (entityTypeId, filter) => findExistingItemId(entityTypeId, filter, (await need()).call),
    originatorPrefix: process.env.IMPORT_ORIGINATOR_ID,
    findCompanyByTaxId: async taxId => findCompanyByTaxId(taxId, (await need()).call),
    findProduct: async item => findProduct(item, mapping, (await need()).call),
    createProduct: async item => createProductViaRest(item, mapping, (await need()).call),
    // VAT rates: full-list fetch via the SDK's built-in pagination (SdkListCall).
    portalVatRates: async () => fetchVatRates((await need()).list),
    portalCurrencies: async () => fetchCurrencies((await need()).call),
    createTarget: async (target, fields) => createTargetItem(target, fields, (await need()).call),
    setRows: async (etid, id, rows) => setProductRows(etid, id, rows, (await need()).call),
    reportErrors: async (messages, supplierName) => {
      if (!messages.length) return
      await bumpCounter(memberId, METRICS.errors, 1, infra.query)
      // Deliver to the error chat (im.message.add, BB-neutralised). Best-effort:
      // a chat failure must not mask the underlying import error.
      if (mapping.errorChatId) {
        try {
          const t = await rest(memberId)
          if (t) await sendChatMessage(mapping.errorChatId, buildErrorMessage(supplierName, messages), t.call)
        } catch { /* swallow — dashboard counter already bumped */ }
      }
    },
    notifySuccess: async (summary) => {
      if (!mapping.notifyChatId) return
      const t = await need()
      await sendChatMessage(mapping.notifyChatId, buildSuccessMessage(summary), t.call)
    },
    // Configurable timeline activity on the created entity (crm.activity.configurable.add,
    // OAuth app context — verified live). Best-effort; runCrmSync swallows failures.
    writeActivity: async ({ entityTypeId, entityId, supplierName, rowCount }) => {
      const params = buildConfigurableActivity({
        entityTypeId,
        ownerId: entityId,
        title: `Импорт: ${supplierName ?? 'документ'}`,
        lines: [`Позиций: ${rowCount}`, ...(supplierName ? [`Поставщик: ${supplierName}`] : [])],
        openPath: entityOpenPath(entityTypeId, entityId)
      })
      await (await need()).call('crm.activity.configurable.add', params)
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
    setJobStatus: (m, j, status, result) => setJobStatus(m, j, status, result, infra.query),
    deleteDocument: (m, j) => deleteDocument(m, j, infra.query),
    bumpMetrics: async (m, deltas) => {
      for (const [name, by] of Object.entries(deltas)) await bumpCounter(m, name, by, infra.query)
    }
  }
}
