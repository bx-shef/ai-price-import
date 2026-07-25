// Pure builder for a CRM entity's detail path on the portal — used to link the import result row to
// the created deal/invoice/smart-process (opened via frame.slider.openPath, or as an absolute link).
// deal (2) and lead (1) have named routes; smart-invoice (31) and smart processes (>=1000) use the
// universal /crm/type/<entityTypeId>/details/<id>/ route. Portal-relative (no domain) — the caller
// anchors it to the portal origin. Returns null for invalid ids (no broken link).

export function entityDetailPath(entityTypeId: number | undefined | null, entityId: number | undefined | null): string | null {
  if (!Number.isInteger(entityTypeId) || (entityTypeId as number) <= 0) return null
  if (!Number.isInteger(entityId) || (entityId as number) <= 0) return null
  const etid = entityTypeId as number
  const id = entityId as number
  if (etid === 1) return `/crm/lead/details/${id}/`
  if (etid === 2) return `/crm/deal/details/${id}/`
  return `/crm/type/${etid}/details/${id}/`
}
