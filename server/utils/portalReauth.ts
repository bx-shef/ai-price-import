import type { EnsureDeps } from './ensureAccessToken'
import { ensureFreshToken } from './ensureAccessToken'
import type { QueryFn, SaveTokenInput } from './tokenStore'
import { getToken, updateTokensOnRefresh } from './tokenStore'
import { withAdvisoryLock } from './dbLock'
import { decryptSecret, encryptSecret } from './secretCrypto'
import type { FetchFn } from './b24Rest'
import { REST_TIMEOUT_MS } from './b24Rest'

// Operator token-reauth action (#132): FORCE-refresh one portal's OAuth token from the /queues
// UI instead of the SSH dev-script (which rotates the refresh token as a side effect). Reuses the
// exact refresh path crm-sync/keep-alive use (ensureFreshToken → per-portal advisory lock #35 →
// UPDATE-only persist). Returns a NON-SECRET outcome — the token itself never leaves the server.

/** Non-secret infra for the reauth action (env + db + fetch). */
export interface ReauthInfra {
  query: QueryFn
  fetchFn: FetchFn
  /** AES key (base64) for refresh-token decrypt/encrypt. */
  encKey: string
  clientId: string
  clientSecret: string
  now: () => number
}

/** Assemble the OAuth-refresh EnsureDeps from the shared primitives (same wiring as
 *  liveDeps.ensureDeps; the refresh POST runs inside the lock, so it is AbortSignal-bounded so a
 *  hung oauth.bitrix.info cannot pin the lock + pooled connection). */
function reauthEnsureDeps(infra: ReauthInfra): EnsureDeps {
  return {
    getToken: m => getToken(m, infra.query),
    withLock: withAdvisoryLock,
    loadToken: (q, m) => getToken(m, q),
    persistRefresh: (q: QueryFn, input: SaveTokenInput) => updateTokensOnRefresh(input, q),
    refreshTransport: async (params) => {
      const res = await infra.fetchFn(
        `https://oauth.bitrix.info/oauth/token/?${new URLSearchParams(params).toString()}`,
        { signal: AbortSignal.timeout(REST_TIMEOUT_MS) }
      )
      return res.json()
    },
    decrypt: enc => (enc ? decryptSecret(enc, infra.encKey) : ''),
    encrypt: plain => encryptSecret(plain, infra.encKey),
    clientId: infra.clientId,
    clientSecret: infra.clientSecret,
    now: infra.now
  }
}

/** NON-SECRET outcome of a reauth attempt. */
export type ReauthOutcome = 'refreshed' | 'not-installed' | 'failed'

/**
 * Force-refresh one portal's OAuth token under its per-portal advisory lock, persisting
 * UPDATE-only (never resurrects a purged portal). NON-SECRET result only:
 *  - 'refreshed'     — the token rotated + persisted;
 *  - 'not-installed' — the portal vanished (no token / no refresh token — benign);
 *  - 'failed'        — a dead/rejected grant (invalid_grant, app removed, PAYMENT_REQUIRED).
 * Never returns or logs the token.
 */
export async function reauthPortal(memberId: string, infra: ReauthInfra): Promise<ReauthOutcome> {
  try {
    await ensureFreshToken(memberId, reauthEnsureDeps(infra), true)
    return 'refreshed'
  } catch (e) {
    const msg = String((e as Error)?.message ?? e)
    if (/no (token|refresh token)/i.test(msg)) return 'not-installed'
    return 'failed'
  }
}
