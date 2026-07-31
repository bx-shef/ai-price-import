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

  function get(): B24Frame | null {
    return frame
  }

  /** Frame auth for server API headers, or null when not framed / not ready. */
  function auth(): { accessToken: string, domain: string } | null {
    const a = frame?.auth.getAuthData()
    if (!a || !a.access_token) return null
    return { accessToken: a.access_token, domain: a.domain }
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
    const opts = frame?.placement?.options as Record<string, unknown> | undefined
    return String(opts?.IFRAME ?? '').toUpperCase() === 'Y'
  }

  /** Close THIS app's slider page (`slider.closeSliderAppPage`). Differs from `closeSlider`
   *  (`parent.closeApplication`): used when we are about to re-open ourselves as a slider. */
  async function closeAppSlider(): Promise<void> {
    const f = await init()
    try {
      await f?.slider.closeSliderAppPage()
    } catch { /* not in a slider → nothing to close */ }
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

  return { init, get, auth, inFrame, placementPlace, isSliderMode, openAppSlider, closeAppSlider, closeSlider }
}
