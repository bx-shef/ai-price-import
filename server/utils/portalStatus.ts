// Pure health model for the portal token-status view (#132): show the owner which portals are
// installed and how close each is to losing authorization, WITHOUT exposing any secret. The
// refresh_token lives ~180 days from the last time a token pair was received (install or refresh —
// `updated_at`, the same field the keep-alive cron watches, #175). Below the near-expiry threshold
// the keep-alive cron should be refreshing it; a `stale` portal has likely lost its grant.
//
// SECURITY: this module never sees access/refresh tokens — the store SELECT feeding it returns
// only member_id / domain / updated_at (see tokenStore.listPortalStatus). Keep it that way.

/** Refresh-token lifetime B24 grants (days). */
export const REFRESH_LIFETIME_DAYS = 180
/** Warn (near-expiry) when fewer than this many days remain. */
export const NEAR_EXPIRY_DAYS = 30

export type PortalHealth = 'ok' | 'near-expiry' | 'stale'

/** One portal's status for the ops view — NON-SECRET fields only. */
export interface PortalStatus {
  memberId: string
  domain: string
  /** Days since the last token pair was received (install/refresh). */
  ageDays: number
  /** Days until the refresh_token is expected to expire (negative = already past). */
  expiresInDays: number
  health: PortalHealth
}

/** Compute the refresh-token health from when the pair was last received. Pure. */
export function computePortalHealth(updatedAtMs: number, nowMs: number): {
  ageDays: number
  expiresInDays: number
  health: PortalHealth
} {
  const valid = Number.isFinite(updatedAtMs) && updatedAtMs > 0
  const ageDays = valid ? Math.max(0, Math.floor((nowMs - updatedAtMs) / 86_400_000)) : 0
  const expiresInDays = REFRESH_LIFETIME_DAYS - ageDays
  const health: PortalHealth = expiresInDays <= 0 ? 'stale' : expiresInDays <= NEAR_EXPIRY_DAYS ? 'near-expiry' : 'ok'
  return { ageDays, expiresInDays, health }
}

/** A raw store row (only the non-secret columns are read). */
export interface PortalStatusInput {
  memberId: string
  domain: string
  updatedAtMs: number
}

/** Map store rows → sorted status list (soonest-to-expire first, so problems surface at the top). */
export function buildPortalStatuses(rows: PortalStatusInput[], nowMs: number): PortalStatus[] {
  return rows
    .map((r) => {
      const { ageDays, expiresInDays, health } = computePortalHealth(r.updatedAtMs, nowMs)
      return { memberId: r.memberId, domain: r.domain, ageDays, expiresInDays, health }
    })
    .sort((a, b) => a.expiresInDays - b.expiresInDays)
}
