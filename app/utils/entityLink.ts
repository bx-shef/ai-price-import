// Pure builder for a CRM entity's detail path on the portal — used to link the import result row to
// the created deal/invoice/smart-process (opened via frame.slider.openPath, or as an absolute link).
// MIRRORS the server's canonical builders (server/utils/chatNotify.entityLink +
// configurableActivity.entityOpenPath): lead(1)/deal(2) named routes, quote(7)→/crm/quote/show/ (legacy
// static entity — the universal type route does NOT resolve quotes), everything else (smart-invoice 31,
// smart processes) → universal /crm/type/<etid>/details/. Keep in sync with those (a shared util is the
// eventual fix). Portal-relative — the caller anchors it to the portal origin. Null for invalid ids.

/** Plain-Russian name of a CRM entity type, for user-facing result lines («Открыть сделку №12»)
 *  instead of the jargon «сущность #12». A smart process's real title isn't known here (it's
 *  portal-specific) → the neutral «запись». Accusative case — reads right after «Открыть». */
export function entityTypeLabel(entityTypeId: number | undefined | null): string {
  switch (entityTypeId) {
    case 1: return 'лид'
    case 2: return 'сделку'
    case 7: return 'предложение'
    case 31: return 'счёт'
    default: return 'запись'
  }
}

export function entityDetailPath(entityTypeId: number | undefined | null, entityId: number | undefined | null): string | null {
  if (!Number.isInteger(entityTypeId) || (entityTypeId as number) <= 0) return null
  if (!Number.isInteger(entityId) || (entityId as number) <= 0) return null
  const etid = entityTypeId as number
  const id = entityId as number
  if (etid === 1) return `/crm/lead/details/${id}/`
  if (etid === 2) return `/crm/deal/details/${id}/`
  if (etid === 7) return `/crm/quote/show/${id}/`
  return `/crm/type/${etid}/details/${id}/`
}

/**
 * Absolute link to the portal's currency settings (Настройки CRM → Валюты).
 *
 * Needed because the money tile silently cannot exist on a portal with no BASE currency, and the
 * only fix is on the portal side. Built from the portal's OWN domain — never a hard-coded host —
 * and the domain is validated as a bare hostname (no scheme, no slash, no credentials/port), so a
 * spoofed frame domain cannot turn a settings hint into a link to somebody else's site.
 */
export function portalCurrencySettingsUrl(domain: string | undefined | null): string | null {
  const d = String(domain ?? '').trim().toLowerCase()
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return null
  return `https://${d}/crm/configs/currency/`
}
