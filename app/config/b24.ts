// Pure Bitrix24 embedding constants (no I/O). See docs/redesign/02-target-architecture.md.

/** OAuth scopes the app requests (Q9). `placement` intentionally excluded — the app lives on its
 *  own left-menu page (the standard universal «app URL» entry, configured in the Market card, no
 *  placement.bind), so no widget-embedding scope is needed.
 *  `pull` — real-time channel («Мгновенные сообщения системы»): the settings slider fires
 *  `pull.application.event.add` (COMMAND `reload.options`) so other open instances re-read settings
 *  live; without it that call returns 401 (confirmed on a live portal). Same scope the official
 *  b24-ai-starter reference declares. */
export const B24_REQUIRED_SCOPES = ['crm', 'catalog', 'disk', 'im', 'pull'] as const

/** Backend endpoint that receives outgoing B24 events. */
export const B24_EVENT_HANDLER_PATH = '/api/b24/events'

/** `place` values passed to `slider.openSliderAppPage({ place })` to open a secondary page in a B24
 *  slider, and read back from `placement.options.place` by the global middleware to route the freshly-
 *  opened slider frame to the matching in-app route. A call-time param (arrives in PLACEMENT_OPTIONS) —
 *  NOT a registered placement, so no install-time `placement.bind` is needed. Pattern from the official
 *  `bitrix-tools/b24-ai-starter` + `bitrix24/app-template-automation-rules` references. */
export const APP_SLIDER_PLACE_SETTINGS = 'app-options'
export const APP_SLIDER_PLACE_METRICS = 'metrics'

/** place → in-app route the global middleware redirects a freshly-opened slider frame to. */
export const APP_SLIDER_ROUTES: Record<string, string> = {
  [APP_SLIDER_PLACE_SETTINGS]: '/settings',
  [APP_SLIDER_PLACE_METRICS]: '/metrics'
}

/** Events bound on install. */
export const B24_BOUND_EVENTS = ['ONAPPINSTALL', 'ONAPPUNINSTALL'] as const

/** Build the portal-relative path to this app's Bitrix24 Market detail page. Passed to the frame
 *  SDK's `slider.openPath` so the user lands on the listing where they can leave a rating/review.
 *  The path shape is fixed by Bitrix24; `code` is the app's Market listing code (see nuxt.config
 *  `b24MarketCode`). Returns null for an empty code (feature off). */
export function marketDetailPath(code: string): string | null {
  const c = code.trim()
  return c ? `/marketplace/detail/${c}/` : null
}

/** Bitrix24 entityTypeId constants used as import targets.
 *  quote (7) is intentionally excluded — no filterable external-marker field, and an incoming
 *  counterparty document has nothing to import into an outgoing offer (see #135).
 *  lead (1) carries originId/originatorId (marker) — see #135 «Лид как цель». */
export const ENTITY_TYPE_ID = {
  lead: 1,
  deal: 2,
  smartInvoice: 31
} as const
