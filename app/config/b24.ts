// Pure Bitrix24 embedding constants (no I/O). See docs/redesign/02-target-architecture.md.

/** OAuth scopes the app requests (Q9). */
export const B24_REQUIRED_SCOPES = ['crm', 'catalog', 'disk', 'im', 'placement'] as const

/** Backend endpoint that receives outgoing B24 events. */
export const B24_EVENT_HANDLER_PATH = '/api/b24/events'

/** Events bound on install. */
export const B24_BOUND_EVENTS = ['ONAPPINSTALL', 'ONAPPUNINSTALL'] as const

/** Bitrix24 entityTypeId constants used as import targets.
 *  quote (7) is intentionally excluded — no filterable external-marker field (see #135). */
export const ENTITY_TYPE_ID = {
  deal: 2,
  smartInvoice: 31
} as const
