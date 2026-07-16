import type { RestCall } from './b24Rest'

// Find a previously-created CRM item by its idempotency marker (originId/originatorId or xmlId).
// Pure over RestCall (DI). crm.item.list — NOT crm.item.get (which throws NOT_FOUND); the list
// returns an empty set for no match. The filter is built by originMarker.originSearchFilter and
// is already scoped to OUR originator, so the first row is our prior create. See originMarker.ts.

/** Return the id of an existing item matching the marker filter, or null. First row wins. */
export async function findExistingItemId(
  entityTypeId: number,
  filter: Record<string, unknown>,
  call: RestCall
): Promise<number | null> {
  const res = await call('crm.item.list', {
    entityTypeId,
    filter,
    select: ['id']
  }) as { items?: Array<{ id: number | string }> } | undefined
  const first = (res?.items ?? [])[0]
  if (!first) return null
  const id = Number(first.id)
  return Number.isInteger(id) && id > 0 ? id : null
}
