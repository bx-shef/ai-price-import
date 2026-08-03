// Pure Bitrix24 embedding constants (no I/O). See docs/PROCESS.md.

/** OAuth scopes the app requests (Q9). `placement` intentionally excluded — the app lives on its
 *  own left-menu page (the standard universal «app URL» entry, configured in the Market card, no
 *  placement.bind), so no widget-embedding scope is needed.
 *  `pull` — real-time channel («Мгновенные сообщения системы»): the settings slider fires
 *  `pull.application.event.add` (COMMAND `reload.options`) so other open instances re-read settings
 *  live; without it that call returns 401 (confirmed on a live portal). Same scope the official
 *  b24-ai-starter reference declares.
 *  `imbot` — chat notices signed by the APP and not by the employee whose token we hold (#316):
 *  `im.message.add` writes as the token owner, which made import reports look like a colleague
 *  posting into a shared chat and failure notices arrive from the employee to himself. A portal
 *  that does not grant it (installed earlier, or free plan where bots are unavailable) keeps
 *  working — the send falls back to the old method. */
export const B24_REQUIRED_SCOPES = ['crm', 'catalog', 'disk', 'im', 'imbot', 'pull'] as const

/** Backend endpoint that receives outgoing B24 events. */
export const B24_EVENT_HANDLER_PATH = '/api/b24/events'

/** `place` values passed to `slider.openSliderAppPage({ place })` to open a secondary page in a B24
 *  slider, and read back from `placement.options.place` by the global middleware to route the freshly-
 *  opened slider frame to the matching in-app route. A call-time param (arrives in PLACEMENT_OPTIONS) —
 *  NOT a registered placement, so no install-time `placement.bind` is needed. Pattern from the official
 *  `bitrix-tools/b24-ai-starter` + `bitrix24/app-template-automation-rules` references. */
export const APP_SLIDER_PLACE_SETTINGS = 'app-options'
export const APP_SLIDER_PLACE_METRICS = 'metrics'
/** Главный экран, открытый НАМИ в слайдере (#262). Нужен отдельным `place`, а не признаком
 *  `IFRAME=Y`: по нему открытый слайдер опознаётся однозначно и не пытается открыть себя снова. */
export const APP_SLIDER_PLACE_MAIN = 'app-main'

/** place → in-app route the global middleware redirects a freshly-opened slider frame to.
 *  NB: the app's normal left-menu entry (standard universal «app URL») must NOT carry these `place`
 *  values, or the main frame would redirect away from /app on every open — the values are app-chosen
 *  and only ever set by our own `openSliderAppPage` calls, so this coupling holds by construction. */
export const APP_SLIDER_ROUTES: Record<string, string> = {
  [APP_SLIDER_PLACE_SETTINGS]: '/settings',
  [APP_SLIDER_PLACE_METRICS]: '/metrics',
  [APP_SLIDER_PLACE_MAIN]: '/app'
}

/** Pure: the in-app route a slider frame opened with `place` should redirect to (undefined = none). */
export function sliderRouteForPlace(place: string | undefined | null): string | undefined {
  return place ? APP_SLIDER_ROUTES[place] : undefined
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

/**
 * Absolute link that opens THIS app inside the portal (#385).
 *
 * ⚠ Not to be confused with `marketDetailPath` above: `/marketplace/detail/<code>/` is the Market
 * LISTING (where a rating is left), `/marketplace/view/<code>/` is the app ITSELF. The failure
 * message in chat used to point at `NUXT_PUBLIC_SITE_URL + '/app'`, i.e. at our own host — opened
 * outside the portal there is no frame, no frame token and no member_id, so the promised way back
 * was a dead end. The address must be built from the PORTAL's domain, never from ours.
 *
 * The symbolic-code form is used rather than the numeric `/marketplace/app/<ID>/`: `ID` is local to
 * each portal (it comes from `app.info`, which additionally only answers in application context),
 * while the code is the same everywhere and needs no REST call.
 *
 * Returns null when the portal host or the code is unknown — the caller then sends the text without
 * a link. A broken link is worse than no link: it promises a way back and leads nowhere.
 */
export function portalAppUrl(portalDomain: string | undefined | null, code: string): string | null {
  const host = portalHost(portalDomain)
  const c = code.trim()
  return host && c ? `https://${host}/marketplace/view/${c}/` : null
}

/**
 * Portal host out of a stored `portal_tokens.domain` — a bare host or a full URL, either case.
 *
 * ⚠ Two layers, and both are needed. First `new URL` PARSES (not a regex — the same bar as
 * `isSafeB24Domain` and the crawler-file base, #304): `.hostname` drops userinfo, port, query and
 * fragment by construction and normalises the case, so `x.bitrix24.by@evil.com` cannot survive as
 * a host that READS like the portal and RESOLVES to evil.com. Then the cloud-zone predicate
 * REJECTS what is left over — parsing alone accepted `evil.com` outright.
 *
 * The second layer is the point: the link's caption is fixed («открыть приложение», «Открыть в
 * CRM»), so a substituted host is invisible to the reader, and they click it exactly when they have
 * just been told the import failed. Mirrors `portalCurrencySettingsUrl`, which solves the same
 * problem and was already strict; the first version of this function was below that bar.
 *
 * Unknown host ⇒ null ⇒ the caller sends its text without a link.
 */
export function portalHost(portalDomain: string | undefined | null): string | null {
  const raw = String(portalDomain ?? '').trim()
  if (!raw) return null
  let host: string
  try {
    host = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase()
  } catch {
    return null
  }
  // com.tr/com.br — the two official TWO-label cloud zones (#323), same alternation as the server guard.
  return /^([a-z0-9-]+\.)+bitrix24\.(com\.(tr|br)|[a-z]{2,})$/.test(host) ? host : null
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
