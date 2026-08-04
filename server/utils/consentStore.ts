import type { QueryFn } from './tokenStore'
import type { LegalEdition } from '../../app/utils/legalEdition'

// Запись о принятии документов, одна на портал (#414). Над инъектируемым `QueryFn` — тестируется
// без базы, как остальные сторы.

export interface PortalConsent {
  acceptedAt: Date
  eulaEdition: string
  privacyEdition: string
}

/** Есть ли согласие у портала. `null` — нет строки, то есть согласия нет. */
export async function getConsent(memberId: string, query: QueryFn): Promise<PortalConsent | null> {
  const { rows } = await query(
    'SELECT accepted_at, eula_edition, privacy_edition FROM portal_consent WHERE member_id=$1',
    [memberId]
  )
  const r = rows[0]
  if (!r) return null
  return {
    acceptedAt: r.accepted_at instanceof Date ? r.accepted_at : new Date(String(r.accepted_at)),
    eulaEdition: String(r.eula_edition),
    privacyEdition: String(r.privacy_edition)
  }
}

/**
 * Записать согласие. Идемпотентно и **неизменяемо**: `DO NOTHING`, а не `DO UPDATE`.
 *
 * ⚠ Второй клик по галочке (обновили страницу, открыли в другом окне) НЕ должен переписывать дату:
 * силу имеет первое согласие, и именно на его дату потом ссылаются. Перезапись молча сдвигала бы
 * доказательство вперёд — а в споре важно, что документ приняли ДО того, как через приложение
 * прошёл первый документ.
 *
 * Редакции приходят от сервера (`CURRENT_EDITIONS`), не из тела запроса.
 */
export async function recordConsent(memberId: string, editions: { eula: LegalEdition, privacy: LegalEdition }, query: QueryFn): Promise<void> {
  await query(
    `INSERT INTO portal_consent (member_id, eula_edition, privacy_edition)
     VALUES ($1, $2, $3) ON CONFLICT (member_id) DO NOTHING`,
    [memberId, editions.eula.edition, editions.privacy.edition]
  )
}
