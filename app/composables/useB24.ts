import { initializeB24Frame, type B24Frame } from '@bitrix24/b24jssdk'

// Minimal Bitrix24 frame wrapper. init() is idempotent and a no-op outside a portal
// iframe (no window.name) — so in-portal pages render both standalone and framed.
// The frame auth (access token + domain) is what the server API routes verify.

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
      initPromise = initializeB24Frame()
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

  return { init, get, auth, inFrame }
}
