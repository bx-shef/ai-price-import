import type { B24Frame } from '@bitrix24/b24jssdk'

// Minimal Bitrix24 frame wrapper. init() is idempotent and a no-op outside a portal
// iframe (no window.name) — so in-portal pages render both standalone and framed.
// The frame auth (access token + domain) is what the server API routes verify.
// The SDK is imported DYNAMICALLY inside init() (only value import is `initializeB24Frame`) so this
// composable — pulled into the common chunk via the global slider middleware — does NOT bundle the B24
// SDK into the public landing's entry; it loads only when a real frame handshake happens.

let frame: B24Frame | null = null
let initPromise: Promise<B24Frame | null> | null = null

export function useB24() {
  function inFrame(): boolean {
    return import.meta.client && typeof window !== 'undefined' && window.name !== ''
  }

  async function init(): Promise<B24Frame | null> {
    if (frame) return frame
    if (!inFrame()) return null
    if (!initPromise) {
      initPromise = import('@bitrix24/b24jssdk')
        .then(({ initializeB24Frame }) => initializeB24Frame())
        .then((f) => {
          frame = f
          return f
        })
        .catch(() => {
          // Don't cache a failed handshake — reset so the next init() retries
          // (a transient BX24 timing race must not kill the UI until page reload).
          initPromise = null
          return null
        })
    }
    return initPromise
  }

  /**
   * One refresh for everybody, and never an unbounded wait.
   *
   * ⚠ Two measured defects, both introduced by the naive version.
   *
   * 1. `refreshAuth()` sends a postMessage to the parent and — unlike the SDK's own HTTP path —
   *    arms NO timeout for it (`send()` only does that for `isSafely` calls). If the parent never
   *    answers (the portal went to a login page, the tab is dead, the origin was rejected) the
   *    promise simply never settles: not a rejection, silence. Measured: `ensureAuth()` did not
   *    finish at all, where the old code returned null synchronously. Composables that guard with
   *    an `inFlight` promise then keep it forever and hand the same pending promise to every future
   *    caller — pickers spin for good, and an upload batch hangs under «не закрывайте страницу»
   *    with no error at all. That is worse than the wrong message this issue set out to fix.
   *
   * 2. Thirteen composables mount together on `/app`, so an expired hour produced thirteen
   *    simultaneous refreshes. The SDK's own HTTP layer deliberately coalesces in-flight refreshes;
   *    the frame layer does not. Measured with a realistic round-trip: 13 calls. (A synchronous
   *    fake shows 1 — a comfortable lie worth knowing about.)
   */
  const REFRESH_TIMEOUT_MS = 10_000
  let refreshPromise: Promise<void> | null = null

  function refreshOnce(f: B24Frame): Promise<void> {
    if (!refreshPromise) {
      refreshPromise = Promise.race([
        f.auth.refreshAuth().then(() => undefined),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('refreshAuth timed out')), REFRESH_TIMEOUT_MS))
      ]).finally(() => {
        refreshPromise = null
      })
    }
    return refreshPromise
  }

  function get(): B24Frame | null {
    return frame
  }

  /** Frame auth for server API headers, or null when not framed / not ready. */
  function auth(): { accessToken: string, domain: string } | null {
    const a = frame?.auth.getAuthData()
    if (!a || !a.access_token) return null
    return { accessToken: a.access_token, domain: a.domain }
  }

  /**
   * Frame auth, refreshing it once when it has expired (#345).
   *
   * Frame authorisation lives about an hour. When it runs out the SDK's `getAuthData()` returns
   * `false` — not a stale token — so `auth()` above yields null, every frame-token path takes its
   * «not in a portal» branch, and a person looking at the app INSIDE the portal is told the app is
   * not open in Bitrix24. The information to tell the two apart was there all along (`inFrame()` is
   * still true); it simply was not used, and each caller had its own copy of the wrong message.
   *
   * `refreshAuth()` is exactly the SDK call for this (wrapper over `BX24.refreshAuth`). Fixing it
   * here fixes uploads, settings, metrics, feedback, rating and the pickers at once — six
   * half-fixes were the alternative.
   *
   * Still null after the refresh ⇒ the PORTAL's own session ended (the person logged out, the
   * portal reloaded). That is a different situation and gets a different message; see
   * `frameAuthMessage`.
   */
  async function ensureAuth(): Promise<{ accessToken: string, domain: string } | null> {
    const current = auth()
    if (current) return current
    // Own `init()`, not «the caller surely did it»: `useAppRating.report()` already relies on an
    // earlier `check()` having run, so a first call in the wrong order would silently get null
    // without a single attempt.
    const f = await init()
    if (!inFrame() || !f) return null
    try {
      await refreshOnce(f)
    } catch (e) {
      // Nothing here is actionable for the user — but three different causes (portal refused,
      // parent never answered, SDK not ready) otherwise look identical from the browser, and there
      // is no live debugging inside a portal frame. The token itself is never logged.
      console.warn('[b24] frame auth refresh failed:', e instanceof Error ? e.message : e)
    }
    return auth()
  }

  /** The `place` this frame was opened with (from `openSliderAppPage({ place })` → PLACEMENT_OPTIONS).
   *  Undefined for a normally-opened app page. The global middleware uses it to route a slider frame. */
  function placementPlace(): string | undefined {
    const opts = frame?.placement?.options as Record<string, unknown> | undefined
    const p = opts?.place
    return typeof p === 'string' && p ? p : undefined
  }

  /** Are we ourselves rendered inside a B24 slider? Reads PLACEMENT_OPTIONS `IFRAME` (SDK
   *  `placement.isSliderMode`), NOT the URL. Used by the launcher (#262) so a slider never tries to
   *  open another slider of itself. */
  function isSliderMode(): boolean {
    // Спрашиваем сам SDK, а не повторяем его чтение `options.IFRAME` — иначе логика разъедется
    // при её изменении в SDK. Второй признак к нашему `place`; до init() — false, вызывающий
    // (app.vue) дожидается init.
    try {
      return frame?.placement?.isSliderMode === true
    } catch {
      return false
    }
  }

  /** Open THIS app in a B24 slider at the given `place` (self-routed by the global middleware).
   *  Pattern from the official bitrix24/app-template-automation-rules (index.client → openSliderAppPage
   *  with place/width/label/title). Returns false when not framed / on SDK error so the caller can
   *  fall back to plain navigation. `label` renders the coloured badge on the slider header. */
  async function openAppSlider(
    place: string,
    opts: { width?: number, title?: string, label?: { text: string, bgColor?: string, color?: string } } = {}
  ): Promise<boolean> {
    const f = await init()
    if (!f) return false
    try {
      await f.slider.openSliderAppPage({
        place,
        bx24_width: opts.width ?? 900,
        ...(opts.title ? { bx24_title: opts.title } : {}),
        ...(opts.label ? { bx24_label: { bgColor: '#2fc6f6', color: '#ffffff', ...opts.label } } : {})
      })
      return true
    } catch {
      return false
    }
  }

  /** Close the current app slider overlay (parent.closeApplication). No-op / swallows when not framed.
   *  Shared by settings.vue and metrics.vue so the close path isn't duplicated. */
  async function closeSlider(): Promise<void> {
    const f = await init()
    try {
      await f?.parent.closeApplication()
    } catch { /* not framed → nothing to close */ }
  }

  return { init, get, auth, ensureAuth, inFrame, placementPlace, isSliderMode, openAppSlider, closeSlider }
}
