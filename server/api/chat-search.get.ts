import { extractFrameAuth } from '../utils/frameAuth'
import { resolveFrameMember } from '../utils/resolveFrameMember'
import { makePortalSdkCall, sdkPortalDeps } from '../utils/b24Sdk'
import { searchChats } from '../utils/chatSearch'
import { query } from '../db/client'

// GET /api/chat-search?q=<phrase> — search the portal's chats for the settings notify/error
// chat pickers. Auth = the Bitrix24 frame access token (Authorization: Bearer) + portal
// domain (X-B24-Domain). We VERIFY that token controls the domain (resolveFrameMember →
// cheap `profile` call), map it to the installed portal's member_id, then read via the
// portal's stored OAuth token over the SDK transport (same path as crm-sync / catalog
// properties). Read-only, no storage.
//
// member_id is derived from the VERIFIED domain (not client-supplied) → same-portal only,
// no cross-portal reach. The read uses the portal's app-install OAuth token, so it sees the
// portal's chats regardless of the caller's own rights — acceptable: this backs the
// ADMIN-gated settings picker, and the payload is chat titles + DIALOG_IDs (a chat the app
// itself may post to via im.message.add). Matches the app's server-side-OAuth read model.
export default defineEventHandler(async (event) => {
  const auth = extractFrameAuth(getHeaders(event) as Record<string, string | undefined>)
  if (!auth) {
    setResponseStatus(event, 401)
    return { error: 'frame auth required' }
  }
  // Verify the frame token controls this portal + resolve member_id (anti-spoof).
  const resolved = await resolveFrameMember(auth, { fetchFn: globalThis.fetch as never, query })
  if (!resolved.ok || !resolved.memberId) {
    setResponseStatus(event, resolved.status ?? 401)
    return { error: 'frame verification failed' }
  }
  // Server-side ADMIN gate (not just the client-side useIsAdmin): the read below runs on the
  // portal's app OAuth token and would otherwise let ANY in-portal user enumerate chat titles +
  // DIALOG_IDs. Only a portal admin configures settings, so reject non-admins here.
  if (!resolved.admin) {
    setResponseStatus(event, 403)
    return { error: 'admin only' }
  }
  // Read via the portal's stored OAuth token (SDK transport). Missing token ⇒ the app
  // isn't fully installed for this portal — treat like a failed verification.
  const transport = await makePortalSdkCall(resolved.memberId, sdkPortalDeps({
    query,
    clientId: process.env.B24_CLIENT_ID ?? '',
    clientSecret: process.env.B24_CLIENT_SECRET ?? '',
    encKey: process.env.B24_TOKEN_ENC_KEY ?? '',
    now: () => Date.now()
  }))
  if (!transport) {
    setResponseStatus(event, 409)
    return { error: 'portal not authorised (no token)' }
  }
  const q = typeof getQuery(event).q === 'string' ? getQuery(event).q as string : ''
  try {
    // transport is an SdkTransport { call, list }; searchChats needs the single-call RestCall.
    return await searchChats(transport.call, q)
  } catch {
    setResponseStatus(event, 502)
    return { error: 'chat search failed' }
  }
})
