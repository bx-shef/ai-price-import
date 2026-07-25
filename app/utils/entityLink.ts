// Pure builder for a CRM entity's detail path on the portal — used to link the import result row to
// the created deal/invoice/smart-process (opened via frame.slider.openPath, or as an absolute link).
// MIRRORS the server's canonical builders (server/utils/chatNotify.entityLink +
// configurableActivity.entityOpenPath): lead(1)/deal(2) named routes, quote(7)→/crm/quote/show/ (legacy
// static entity — the universal type route does NOT resolve quotes), everything else (smart-invoice 31,
// smart processes) → universal /crm/type/<etid>/details/. Keep in sync with those (a shared util is the
// eventual fix). Portal-relative — the caller anchors it to the portal origin. Null for invalid ids.

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
