import { APP_SLIDER_ROUTES } from '~/config/b24'
import { useB24 } from '~/composables/useB24'

// When the app is opened in a B24 slider via `openSliderAppPage({ place })`, the portal re-opens the
// app's OWN registered handler URL (not a portal path — that would 404) and passes `place` in
// PLACEMENT_OPTIONS. This global middleware reads it and routes the freshly-opened slider frame to the
// matching in-app route (app-options → /settings, metrics → /metrics), so that page renders in the
// slider. A normally-opened app page has no `place` → no redirect. Pattern from the official
// bitrix-tools/b24-ai-starter reference (middleware 01.app.page.or.slider.global). Client-only: the B24
// frame handshake is browser-side.
export default defineNuxtRouteMiddleware(async (to) => {
  if (import.meta.server) return
  const { init, placementPlace } = useB24()
  // Idempotent; no-op (returns null) outside a portal frame → the guard below never fires standalone.
  await init()
  const place = placementPlace()
  const target = place ? APP_SLIDER_ROUTES[place] : undefined
  if (target && to.path !== target) {
    return navigateTo(target)
  }
})
