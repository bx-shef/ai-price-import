import type { QueryFn } from './tokenStore'
import type { AppRatingState } from './appRatingPolicy'

// Per-portal app-rating state over an injected QueryFn (testable without a DB). Keyed by member_id,
// like portal_tokens — the rating fact is kept «рядом с авторизацией». All writes are UPSERTs so a
// portal with no row yet is handled transparently.

/** Read the rating state for a portal, or null when there is no row yet. */
export async function getRatingState(memberId: string, query: QueryFn): Promise<AppRatingState | null> {
  const { rows } = await query(
    'SELECT prompted_at, opened_at, reviewed FROM portal_app_rating WHERE member_id=$1',
    [memberId]
  )
  const r = rows[0]
  if (!r) return null
  return {
    promptedAt: r.prompted_at ? new Date(r.prompted_at as string) : null,
    openedAt: r.opened_at ? new Date(r.opened_at as string) : null,
    reviewed: r.reviewed === true
  }
}

/** Stamp prompted_at = now() (the modal was actually shown). Upserts the row. Never touches a
 *  confirmed review (defense-in-depth — the policy already stops prompting a reviewed portal). */
export async function markPrompted(memberId: string, query: QueryFn): Promise<void> {
  await query(
    `INSERT INTO portal_app_rating (member_id, prompted_at) VALUES ($1, now())
     ON CONFLICT (member_id) DO UPDATE SET prompted_at = now(), updated_at = now()
       WHERE portal_app_rating.reviewed = false`,
    [memberId]
  )
}

/** Stamp opened_at = now() (the user clicked «Оценить» → opened the Market page). Upserts the row.
 *  Never overwrites a confirmed review. */
export async function markOpened(memberId: string, query: QueryFn): Promise<void> {
  await query(
    `INSERT INTO portal_app_rating (member_id, opened_at) VALUES ($1, now())
     ON CONFLICT (member_id) DO UPDATE SET opened_at = now(), updated_at = now()
       WHERE portal_app_rating.reviewed = false`,
    [memberId]
  )
}

/** MANUAL (owner op): mark a confirmed review → terminal, never prompt again. */
export async function markReviewed(memberId: string, query: QueryFn): Promise<void> {
  await query(
    `INSERT INTO portal_app_rating (member_id, reviewed) VALUES ($1, true)
     ON CONFLICT (member_id) DO UPDATE SET reviewed = true, updated_at = now()`,
    [memberId]
  )
}

/** MANUAL (owner op): clear opened_at AND prompted_at (no review appeared after the verification
 *  window) so the modal shows again on the user's next successful import — «модалка снова
 *  показывается». No-op on a confirmed review. */
export async function clearOpened(memberId: string, query: QueryFn): Promise<void> {
  await query(
    `UPDATE portal_app_rating SET opened_at = NULL, prompted_at = NULL, updated_at = now()
     WHERE member_id = $1 AND reviewed = false`,
    [memberId]
  )
}
