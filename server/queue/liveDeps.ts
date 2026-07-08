import type { QueryFn } from '../utils/tokenStore'
import type { FetchFn, RestCall } from '../utils/b24Rest'
import type { AgentSpawn } from '../agent/runAgent'
import type { ExtractRunners } from '../utils/textExtract'
import type { EnsureDeps } from '../utils/ensureAccessToken'
import { getToken, saveToken } from '../utils/tokenStore'
import { makePortalRestCall } from '../utils/portalRest'
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
import { extractText } from '../utils/textExtract'
import { runAgent } from '../agent/runAgent'
import { buildExtractionPrompt } from '../../prompts/extract'
import { enqueueAgent, enqueueCrmSync } from './producers'
import type { AgentRunDeps, FileExtractDeps, HandlerDeps } from './handlers'
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
    saveToken: input => saveToken(input, infra.query),
    refreshTransport: async (params) => {
      const res = await infra.fetchFn(`https://oauth.bitrix.info/oauth/token/?${new URLSearchParams(params).toString()}`)
      return res.json()
    },
    decrypt: enc => (enc ? decryptSecret(enc, infra.encKey) : ''),
    encrypt: plain => encryptSecret(plain, infra.encKey),
    clientId: infra.clientId,
    clientSecret: infra.clientSecret,
    now: infra.now
  }
}

/** Memoised per-portal RestCall resolver (null when the portal has no token). */
function restResolver(infra: LiveInfra): (memberId: string) => Promise<RestCall | null> {
  const cache = new Map<string, Promise<RestCall | null>>()
  const deps = { ...ensureDeps(infra), fetchFn: infra.fetchFn }
  return (memberId) => {
    let p = cache.get(memberId)
    if (!p) {
      p = makePortalRestCall(memberId, deps)
      cache.set(memberId, p)
    }
    return p
  }
}

/** Load the portal mapping via server-side REST (falls back to defaults). */
async function loadMapping(memberId: string, rest: (m: string) => Promise<RestCall | null>): Promise<PortalMapping> {
  const call = await rest(memberId)
  if (!call) return defaultMapping()
  try {
    return await readMapping(call)
  } catch {
    return defaultMapping()
  }
}

/** file-extract deps: real extract runners + text store + queue + status. */
export function liveFileExtractDeps(infra: LiveInfra): FileExtractDeps {
  return {
    extractText: (_m, _j, fileId) => extractText(fileId, fileId, infra.runners),
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
        { spawn: infra.agentSpawn, sleep: ms => new Promise(res => setTimeout(res, ms)), random: () => 0.5 }
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

/** crm-sync deps bound to one portal+job (deterministic lookups via portal REST). */
function liveCrmSyncDeps(memberId: string, rest: (m: string) => Promise<RestCall | null>, infra: LiveInfra): CrmSyncDeps {
  const need = async (): Promise<RestCall> => {
    const call = await rest(memberId)
    if (!call) throw new Error('портал не авторизован (нет токена)')
    return call
  }
  // MVP productLookup resolves by name and ignores the mapping; when article-based
  // lookup lands, thread the job's real mapping into crmSyncDeps.
  const mappingForLookup: PortalMapping = defaultMapping()
  return {
    getExisting: jobId => getExistingResult(memberId, jobId, infra.query),
    findCompanyByTaxId: async taxId => findCompanyByTaxId(taxId, await need()),
    findProduct: async item => findProduct(item, mappingForLookup, await need()),
    portalVatRates: async () => fetchVatRates(await need()),
    portalCurrencies: async () => fetchCurrencies(await need()),
    createTarget: async (target, fields) => createTargetItem(target, fields, await need()),
    setRows: async (etid, id, rows) => setProductRows(etid, id, rows, await need()),
    recordResult: (jobId, etid, id) => recordResult(memberId, jobId, etid, id, infra.query),
    reportErrors: async (messages) => {
      // MVP: count errors for the operator dashboard; error-chat delivery (im.message.add
      // to mapping.errorChatId with BB-neutralised text) is the next slice.
      if (messages.length) await bumpCounter(memberId, METRICS.errors, 1, infra.query)
    }
  }
}

/** crm-sync handler deps: mapping + stored doc + per-job crm deps + status + cleanup. */
export function liveCrmSyncHandlerDeps(infra: LiveInfra): HandlerDeps {
  const rest = restResolver(infra)
  return {
    getMapping: m => loadMapping(m, rest),
    getDocument: (m, j) => getDocument(m, j, infra.query),
    crmSyncDeps: (m, _j) => liveCrmSyncDeps(m, rest, infra),
    setJobStatus: (m, j, status, result) => setJobStatus(m, j, status, result, infra.query),
    deleteDocument: (m, j) => deleteDocument(m, j, infra.query)
  }
}
