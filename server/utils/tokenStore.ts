// Per-portal token store over an injected QueryFn (testable without a real DB).
// application_token is write-once (a later forged install can't hijack a portal).

export type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>

export interface PortalToken {
  memberId: string
  domain: string
  clientEndpoint: string
  accessToken: string
  refreshTokenEnc: string
  applicationToken: string
  expiresIn: number
  issuedAtMs: number
  refreshedAtMs: number
}

export interface SaveTokenInput {
  memberId: string
  domain: string
  clientEndpoint?: string
  accessToken?: string
  refreshTokenEnc?: string
  applicationToken?: string
  expiresIn?: number
  issuedAtMs?: number
  refreshedAtMs?: number
}

/**
 * Upsert a portal token. application_token is write-once (kept if already set).
 *
 * Event-ordering guard (`eventTs` = the B24 event timestamp, monotone — an install
 * fires before its uninstall). When `eventTs > 0` and a tombstone with `deleted_ts >=
 * eventTs` exists, a same-or-newer uninstall already removed the portal, so this (stale)
 * register is a no-op and MUST NOT resurrect it with obsolete creds (returns `false`,
 * writes nothing). A genuine reinstall (strictly newer `eventTs`) proceeds and clears the
 * stale tombstone. `eventTs === 0` (a token REFRESH, no ordering) keeps the pre-guard
 * behaviour: always write. Returns whether the row was written.
 *
 * The tombstone SELECT + upsert are two statements (not one transaction). This is
 * TOCTOU-free for the bug it fixes: the `b24-events` worker is SINGLE-INSTANCE (runs only
 * on the cron/primary instance — see server/plugins/queue.ts) and concurrency-1, so a
 * portal's register/unregister never overlap. The token-REFRESH path does NOT use this
 * function — it uses `updateTokensOnRefresh` (UPDATE-only), so a refresh landing after an
 * uninstall purge cannot resurrect the portal (0 rows updated). Hence `saveToken` is only
 * ever called for a real install (with eventTs, via the events consumer/sync fallback).
 */
export async function saveToken(input: SaveTokenInput, query: QueryFn, eventTs = 0): Promise<boolean> {
  if (eventTs > 0) {
    const blocked = await query('SELECT 1 FROM portal_tombstone WHERE member_id = $1 AND deleted_ts >= $2', [input.memberId, eventTs])
    if (blocked.rows[0]) return false // a same-or-newer uninstall already removed this portal
  }
  await query(
    `INSERT INTO portal_tokens
       (member_id, domain, client_endpoint, access_token, refresh_token_enc, application_token, expires_in, issued_at_ms, refreshed_at_ms, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     ON CONFLICT (member_id) DO UPDATE SET
       domain            = EXCLUDED.domain,
       client_endpoint   = EXCLUDED.client_endpoint,
       access_token      = EXCLUDED.access_token,
       refresh_token_enc = EXCLUDED.refresh_token_enc,
       application_token = COALESCE(NULLIF(portal_tokens.application_token, ''), EXCLUDED.application_token),
       expires_in        = EXCLUDED.expires_in,
       issued_at_ms      = EXCLUDED.issued_at_ms,
       refreshed_at_ms   = EXCLUDED.refreshed_at_ms,
       updated_at        = now()`,
    [
      input.memberId, input.domain, input.clientEndpoint ?? '', input.accessToken ?? '',
      input.refreshTokenEnc ?? '', input.applicationToken ?? '', input.expiresIn ?? 3600,
      input.issuedAtMs ?? 0, input.refreshedAtMs ?? 0
    ]
  )
  // A genuine reinstall (newer ts) clears the obsolete tombstone so a later stale
  // uninstall can't re-block it. (Same-or-newer tombstones already short-circuited above.)
  if (eventTs > 0) await query('DELETE FROM portal_tombstone WHERE member_id = $1 AND deleted_ts < $2', [input.memberId, eventTs])
  return true
}

/**
 * Refresh-path persist — UPDATE-only (never INSERT). A token REFRESH must not be able to
 * (re)create a portal: if a concurrent ONAPPUNINSTALL already purged the row, this UPDATE
 * matches 0 rows and the portal stays gone — no resurrection with live creds after
 * uninstall. Absence of the row IS the guard, so no tombstone/eventTs is consulted (unlike
 * the install path). application_token is not touched (write-once; a refresh never carries it).
 * This is the ai-price-import stand-in for client-bank's advisory-lock refresh guard (#35),
 * pending that port (issue #85).
 */
export async function updateTokensOnRefresh(input: SaveTokenInput, query: QueryFn): Promise<void> {
  await query(
    `UPDATE portal_tokens SET
       domain            = $2,
       client_endpoint   = $3,
       access_token      = $4,
       refresh_token_enc = $5,
       expires_in        = $6,
       issued_at_ms      = $7,
       refreshed_at_ms   = $8,
       updated_at        = now()
     WHERE member_id = $1`,
    [
      input.memberId, input.domain, input.clientEndpoint ?? '', input.accessToken ?? '',
      input.refreshTokenEnc ?? '', input.expiresIn ?? 3600, input.issuedAtMs ?? 0, input.refreshedAtMs ?? 0
    ]
  )
}

function mapRow(r: Record<string, unknown>): PortalToken {
  return {
    memberId: String(r.member_id),
    domain: String(r.domain),
    clientEndpoint: String(r.client_endpoint ?? ''),
    accessToken: String(r.access_token ?? ''),
    refreshTokenEnc: String(r.refresh_token_enc ?? ''),
    applicationToken: String(r.application_token ?? ''),
    expiresIn: Number(r.expires_in ?? 3600),
    issuedAtMs: Number(r.issued_at_ms ?? 0),
    refreshedAtMs: Number(r.refreshed_at_ms ?? 0)
  }
}

export async function getToken(memberId: string, query: QueryFn): Promise<PortalToken | null> {
  const { rows } = await query('SELECT * FROM portal_tokens WHERE member_id = $1', [memberId])
  return rows[0] ? mapRow(rows[0]) : null
}

/** Resolve the portal member_id from its domain. Null when not installed. `domain`
 * is not unique-constrained (a stale reinstall row could duplicate it), so ORDER BY
 * member_id makes the auth pivot deterministic rather than arbitrary. */
export async function getMemberIdByDomain(domain: string, query: QueryFn): Promise<string | null> {
  const { rows } = await query('SELECT member_id FROM portal_tokens WHERE domain = $1 ORDER BY member_id LIMIT 1', [domain])
  const id = rows[0]?.member_id
  return id ? String(id) : null
}

/** One installed portal, NON-SECRET fields only (for the ops token-status view, #132). */
export interface PortalStatusRow {
  memberId: string
  domain: string
  /** Epoch ms of the last token pair received (install/refresh) — `updated_at`. */
  updatedAtMs: number
}

/**
 * List installed portals for the owner status view — member_id / domain / updated_at ONLY.
 * SECURITY: this SELECT deliberately excludes every token column (access_token,
 * refresh_token_enc, application_token) so secrets can never reach the ops UI. Bounded by
 * `limit` (a portal count in the thousands is already an operational outlier).
 */
export async function listPortalStatus(query: QueryFn, limit = 500): Promise<PortalStatusRow[]> {
  const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 5000) : 500
  const { rows } = await query(
    // member_id tie-break (like getMemberIdByDomain) makes the LIMIT cutoff deterministic when
    // several portals share an updated_at (batch install → same now()), so a row can't flicker
    // in/out of the capped page between refreshes.
    `SELECT member_id, domain, (EXTRACT(EPOCH FROM updated_at) * 1000)::bigint AS updated_at_ms
     FROM portal_tokens ORDER BY updated_at ASC, member_id ASC LIMIT $1`,
    [cap]
  )
  return rows.map(r => ({
    memberId: String(r.member_id ?? ''),
    domain: String(r.domain ?? ''),
    updatedAtMs: Number(r.updated_at_ms ?? 0)
  }))
}

export async function getApplicationToken(memberId: string, query: QueryFn): Promise<string | null> {
  const { rows } = await query('SELECT application_token FROM portal_tokens WHERE member_id = $1', [memberId])
  const t = rows[0]?.application_token
  return t ? String(t) : null
}

/** Delete ALL data for a portal (ONAPPUNINSTALL — always purge, incl. client
 * documents: import_text raw text + import_doc extracted structure). Leaving any
 * client data after uninstall is a data-minimisation/privacy breach (docs 05). */
export async function deletePortal(memberId: string, query: QueryFn, eventTs = 0): Promise<void> {
  // Ordering guard (#77): record a TOMBSTONE (member_id, deleted_ts) BEFORE purging so a
  // stale/out-of-order register can't resurrect the portal — saveToken refuses to write
  // when a same-or-newer tombstone exists. GREATEST keeps the NEWEST uninstall ts on
  // redelivery. portal_tombstone is deliberately NOT in the purge loop (it must outlive it).
  if (eventTs > 0) {
    await query(
      `INSERT INTO portal_tombstone (member_id, deleted_ts) VALUES ($1, $2)
       ON CONFLICT (member_id) DO UPDATE SET deleted_ts = GREATEST(portal_tombstone.deleted_ts, EXCLUDED.deleted_ts)`,
      [memberId, eventTs]
    )
  }
  for (const table of ['portal_tokens', 'job_result', 'metrics_counter', 'import_job', 'import_text', 'import_doc']) {
    await query(`DELETE FROM ${table} WHERE member_id = $1`, [memberId])
  }
}
