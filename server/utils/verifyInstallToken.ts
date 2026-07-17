import type { RestCall } from './b24Rest'
import { isAuthRejection } from './b24Rest'
import { makeBareTokenSdkCall } from './b24Sdk'

// First-install authentication (Bitrix24 «Безопасность в обработчиках»): the first
// ONAPPINSTALL delivers a fresh application_token there is nothing yet to compare
// against, so instead we prove the delivered access_token really controls the portal
// by making one cheap authed REST call (`profile`). If it succeeds the install is
// genuine (a forged event cannot supply a working OAuth token); we then remember the
// application_token for every later event. Mirrors resolveFrameMember step 1.
// The call rides the SDK (bare-token transport) — the install access token has no
// server-side refresh, so an auth error means a forged/expired token. Never throws.

export interface InstallVerifyResult {
  ok: boolean
  /** 403 = access token rejected (forged/expired install); 503 = transport error. */
  status?: 403 | 503
}

/** Bare-token REST factory. Prod uses the SDK transport (makeBareTokenSdkCall); tests inject
 *  a fake so verification logic stays unit-testable without a live portal. */
export type MakeBareCall = (domain: string, accessToken: string) => RestCall

export async function verifyInstallToken(
  domain: string,
  accessToken: string,
  makeCall: MakeBareCall = makeBareTokenSdkCall
): Promise<InstallVerifyResult> {
  if (!domain || !accessToken) return { ok: false, status: 403 }
  try {
    await makeCall(domain, accessToken)('profile')
    return { ok: true }
  } catch (e) {
    // Auth rejection → the token does not control the portal → 403; a transport/network
    // failure → 503 (cannot verify right now) rather than silently trusting a forgery.
    return { ok: false, status: isAuthRejection(e) ? 403 : 503 }
  }
}
