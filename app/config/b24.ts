// Pure Bitrix24 embedding constants (no I/O). See docs/redesign/02-target-architecture.md.

/** OAuth scopes the app requests (Q9). `placement` intentionally excluded — the app lives on its
 *  own left-menu page (the standard universal «app URL» entry, configured in the Market card, no
 *  placement.bind), so no widget-embedding scope is needed. */
export const B24_REQUIRED_SCOPES = ['crm', 'catalog', 'disk', 'im'] as const

/** Backend endpoint that receives outgoing B24 events. */
export const B24_EVENT_HANDLER_PATH = '/api/b24/events'

/** Events bound on install. */
export const B24_BOUND_EVENTS = ['ONAPPINSTALL', 'ONAPPUNINSTALL'] as const

/** Bitrix24 entityTypeId constants used as import targets.
 *  quote (7) is intentionally excluded — no filterable external-marker field, and an incoming
 *  counterparty document has nothing to import into an outgoing offer (see #135).
 *  lead (1) carries originId/originatorId (marker) — see #135 «Лид как цель». */
export const ENTITY_TYPE_ID = {
  lead: 1,
  deal: 2,
  smartInvoice: 31
} as const
