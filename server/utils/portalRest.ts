import { type FetchFn, isExpiredTokenError, makeRestCall, type RestCall } from './b24Rest'
import { type EnsureDeps, ensureFreshToken } from './ensureAccessToken'

// Bind a portal (member_id) to a live RestCall: ensure a fresh access token,
// call the portal REST, and retry ONCE after a forced refresh on expired_token.

export interface PortalRestDeps extends EnsureDeps {
  fetchFn: FetchFn
}

/** Make a RestCall bound to one portal. Returns null when the portal has no token. */
export async function makePortalRestCall(memberId: string, deps: PortalRestDeps): Promise<RestCall | null> {
  const token = await deps.getToken(memberId)
  if (!token) return null

  return async (method, params) => {
    let fresh = await ensureFreshToken(memberId, deps)
    try {
      return await makeRestCall(fresh.domain, fresh.accessToken, deps.fetchFn)(method, params)
    } catch (err) {
      if (!isExpiredTokenError(err)) throw err
      // Access token rejected server-side before its time — force refresh and retry once.
      fresh = await ensureFreshToken(memberId, deps, true)
      return await makeRestCall(fresh.domain, fresh.accessToken, deps.fetchFn)(method, params)
    }
  }
}
