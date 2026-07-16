// Idempotency marker for a created CRM entity: a job-id stamp written ONTO the entity so a
// crm-sync retry finds it by searching Bitrix24 (no local DB checkpoint). Which field carries
// the marker depends on the entity type — LIVE-VERIFIED via crm.item.fields on the test portal:
//
//   entityTypeId 1/2/3/4 (lead/deal/contact/company) → originId + originatorId  (filterable)
//   entityTypeId 31 (smart-invoice) + >=1000 (dynamic smart-processes) → xmlId   (filterable)
//   entityTypeId 7 (quote/КП) → NEITHER field exists (filter XML_ID "not allowed") → not a
//     target anymore (removed, issue #135); 'none' is returned defensively.
//
// `originId`/`xmlId` carry the job id (unique per import); `originatorId` (origin strategy) or the
// `<originator>:` xmlId prefix carries the app code so our markers never collide with a portal's
// own external-source data. Pure — the search transport lives in the caller.

/** How this entity type stores an external-source marker. */
export type OriginStrategy = 'origin' | 'xmlId' | 'none'

/** Default originator code (the repo code) when IMPORT_ORIGINATOR_ID is unset. */
export const DEFAULT_ORIGINATOR = 'ai-price-import'

/** Dynamic smart-process entityTypeIds start here (SPA); they carry xmlId, not originId. */
const DYNAMIC_TYPE_MIN = 1000
const SMART_INVOICE_TYPE = 31
const ORIGIN_FIELD_TYPES = new Set([1, 2, 3, 4]) // lead / deal / contact / company

/** Pick the marker strategy for an entity type (live-verified field availability). */
export function originStrategy(entityTypeId: number): OriginStrategy {
  if (ORIGIN_FIELD_TYPES.has(entityTypeId)) return 'origin'
  if (entityTypeId === SMART_INVOICE_TYPE || entityTypeId >= DYNAMIC_TYPE_MIN) return 'xmlId'
  return 'none' // quote (7) and anything else without a filterable marker
}

/** Resolve the originator code: an explicit prefix, else the repo-code default. */
export function originatorCode(prefix?: string): string {
  const p = (prefix ?? '').trim()
  return p || DEFAULT_ORIGINATOR
}

/** The xmlId value for a job (`<originator>:<jobId>`) — namespaced so it can't clash. */
export function xmlIdValue(jobId: string, prefix?: string): string {
  return `${originatorCode(prefix)}:${jobId}`
}

/**
 * Marker fields to MERGE into crm.item.add for this entity + job. Empty object when the type
 * has no marker field ('none') — the caller then has no B24 idempotency for it.
 */
export function originMarkerFields(entityTypeId: number, jobId: string, prefix?: string): Record<string, string> {
  switch (originStrategy(entityTypeId)) {
    case 'origin': return { originId: jobId, originatorId: originatorCode(prefix) }
    case 'xmlId': return { xmlId: xmlIdValue(jobId, prefix) }
    case 'none': return {}
  }
}

/**
 * Filter for crm.item.list to find a prior create of this job, or null when the type has no
 * marker field. Exact-match filter (`=`-prefixed keys) — scoped by originator so we only match
 * OUR marker. The caller selects `id` and takes the first row.
 */
export function originSearchFilter(entityTypeId: number, jobId: string, prefix?: string): Record<string, string> | null {
  switch (originStrategy(entityTypeId)) {
    case 'origin': return { '=originId': jobId, '=originatorId': originatorCode(prefix) }
    case 'xmlId': return { '=xmlId': xmlIdValue(jobId, prefix) }
    case 'none': return null
  }
}
