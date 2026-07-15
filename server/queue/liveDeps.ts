import type { QueryFn } from '../utils/tokenStore'
import type { FetchFn } from '../utils/b24Rest'
import { REST_TIMEOUT_MS } from '../utils/b24Rest'
import type { AgentSpawn } from '../agent/runAgent'
import type { ExtractRunners } from '../utils/textExtract'
import type { EnsureDeps } from '../utils/ensureAccessToken'
import { ensureFreshToken } from '../utils/ensureAccessToken'
import { selectTokensNearExpiry, type KeepAliveDeps } from '../utils/tokenKeepAlive'
import { deletePortal, getToken, saveToken, updateTokensOnRefresh } from '../utils/tokenStore'
import { withAdvisoryLock } from '../utils/dbLock'
import { makePortalSdkCall, sdkPortalDeps, type SdkTransport } from '../utils/b24Sdk'
import { purgePortalFiles } from '../utils/nodeFileIO'
import { decryptSecret, encryptSecret } from '../utils/secretCrypto'
import { setJobStatus } from '../utils/jobStore'
import { getText, saveText, deleteText } from '../utils/textStore'
import { getDocument, saveDocument, deleteDocument } from '../utils/docStore'
import { getExistingResult, recordResult } from '../utils/resultStore'
import { bumpCounter, METRICS } from '../utils/metricsStore'
import { readMapping } from '../utils/appSettings'
import { defaultMapping } from '~/utils/portalSettings'
import { findCompanyByTaxId } from '../utils/companyLookup'
import { findProduct } from '../utils/productLookup'
import { fetchVatRates } from '../utils/portalVat'
import { fetchCurrencies } from '../utils/portalCurrency'
import { createTargetItem, setProductRows } from '../utils/crmWrite'
import { buildErrorMessage, buildSuccessMessage, sendChatMessage } from '../utils/chatNotify'
import { extractText } from '../utils/textExtract'
import { uploadPath } from '../utils/fileStore'
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
  fetchFn: FetchFn
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
    refreshTransport: async (params) => {
      // Bound the POST (AbortSignal): it runs INSIDE the advisory lock holding a pooled
      // connection, so a hung oauth.bitrix.info must not pin the lock + connection (dbLock's
      // documented invariant — statement_timeout/lock_timeout don't cover an HTTP await).
      const res = await infra.fetchFn(
        `https://oauth.bitrix.info/oauth/token/?${new URLSearchParams(params).toString()}`,
        { signal: AbortSignal.timeout(REST_TIMEOUT_MS) }
      )
      return res.json()
    },
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
 * Builds a FRESH `B24OAuth` per crm-sync job (NOT cached): the client reads+decrypts the
 * refresh token once and holds it in memory (reactive refresh), so a process-lifetime cache
 * would wedge on a STALE token after any external rotation (a peer replica or the keep-alive
 * cron rotates it → the cached client would fail invalid_grant forever). Per-job means each
 * job re-reads the current DB token, so a rotation is observed next job. `loadToken` is one
 * cheap query; refresh-persist is UPDATE-only (never resurrects a purged portal). */
function restResolver(infra: LiveInfra): (memberId: string) => Promise<SdkTransport | null> {
  const deps = sdkPortalDeps(infra)
  return memberId => makePortalSdkCall(memberId, deps)
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
      const tok = await getToken(memberId, infra.query)
      if (!tok) return 'skipped' // vanished (uninstalled) — nothing to keep alive
      try {
        await ensureFreshToken(memberId, ens, true) // force → rotates; throws on a dead grant
        return 'refreshed'
      } catch (e) {
        // Uninstalled between the read and acquiring the lock → the row vanished under the
        // lock (ensureFreshToken throws "no token"). That is a benign skip, NOT a dead grant.
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
    markExtracting: (m, j) => setJobStatus(m, j, 'extracting', '', infra.query)
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
    deleteText: (m, j) => deleteText(m, j, infra.query),
    markProcessing: (m, j) => setJobStatus(m, j, 'processing', '', infra.query)
  }
}

/**
 * crm-sync deps bound to one portal+job+mapping (deterministic lookups via portal REST).
 * NOTE: `createProduct` is intentionally NOT provided yet — so `mapping.product.onMissing
 * === 'create'` degrades to a freeform product line + an explicit warning in
 * `runCrmSync` (never silent). Wiring real `crm.product.add` is a follow-up (needs the
 * catalog/section policy); until then 'create' behaves like 'freeform'.
 */
function liveCrmSyncDeps(memberId: string, mapping: PortalMapping, rest: (m: string) => Promise<SdkTransport | null>, infra: LiveInfra): CrmSyncDeps {
  const need = async (): Promise<SdkTransport> => {
    const t = await rest(memberId)
    if (!t) throw new Error('портал не авторизован (нет токена)')
    return t
  }
  return {
    getExisting: jobId => getExistingResult(memberId, jobId, infra.query),
    findCompanyByTaxId: async taxId => findCompanyByTaxId(taxId, (await need()).call),
    findProduct: async item => findProduct(item, mapping, (await need()).call),
    // VAT rates: full-list fetch via the SDK's built-in pagination (SdkListCall).
    portalVatRates: async () => fetchVatRates((await need()).list),
    portalCurrencies: async () => fetchCurrencies((await need()).call),
    createTarget: async (target, fields) => createTargetItem(target, fields, (await need()).call),
    setRows: async (etid, id, rows) => setProductRows(etid, id, rows, (await need()).call),
    recordResult: (jobId, etid, id) => recordResult(memberId, jobId, etid, id, infra.query),
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
    }
  }
}

/** crm-sync handler deps: mapping + stored doc + per-job crm deps + status + cleanup. */
export function liveCrmSyncHandlerDeps(infra: LiveInfra): HandlerDeps {
  const rest = restResolver(infra)
  return {
    getMapping: m => loadMapping(m, rest),
    getDocument: (m, j) => getDocument(m, j, infra.query),
    crmSyncDeps: (m, _j, mapping) => liveCrmSyncDeps(m, mapping, rest, infra),
    setJobStatus: (m, j, status, result) => setJobStatus(m, j, status, result, infra.query),
    deleteDocument: (m, j) => deleteDocument(m, j, infra.query),
    bumpMetrics: async (m, deltas) => {
      for (const [name, by] of Object.entries(deltas)) await bumpCounter(m, name, by, infra.query)
    }
  }
}
