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

/** Upsert a portal token. application_token is write-once (kept if already set). */
export async function saveToken(input: SaveTokenInput, query: QueryFn): Promise<void> {
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

/** Resolve the portal member_id from its domain (1:1). Null when not installed. */
export async function getMemberIdByDomain(domain: string, query: QueryFn): Promise<string | null> {
  const { rows } = await query('SELECT member_id FROM portal_tokens WHERE domain = $1 LIMIT 1', [domain])
  const id = rows[0]?.member_id
  return id ? String(id) : null
}

export async function getApplicationToken(memberId: string, query: QueryFn): Promise<string | null> {
  const { rows } = await query('SELECT application_token FROM portal_tokens WHERE member_id = $1', [memberId])
  const t = rows[0]?.application_token
  return t ? String(t) : null
}

/** Delete ALL data for a portal (ONAPPUNINSTALL — always purge, incl. client
 * documents: import_text raw text + import_doc extracted structure). Leaving any
 * client data after uninstall is a data-minimisation/privacy breach (docs 05). */
export async function deletePortal(memberId: string, query: QueryFn): Promise<void> {
  for (const table of ['portal_tokens', 'job_result', 'metrics_counter', 'import_job', 'import_text', 'import_doc']) {
    await query(`DELETE FROM ${table} WHERE member_id = $1`, [memberId])
  }
}
