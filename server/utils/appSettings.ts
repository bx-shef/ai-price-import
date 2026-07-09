import type { RestCall } from './b24Rest'
import { parsePortalSettings } from '~/utils/portalSettings'
import type { PortalMapping } from '~/types/mapping'

// Read/write per-portal settings in app.option (server-side REST by portal token).
// Never trust stored JSON → always run through parsePortalSettings. DI over RestCall.

export const SETTINGS_KEY = 'procure_mapping'

/** Read + normalise the portal mapping from app.option. */
export async function readMapping(call: RestCall, key = SETTINGS_KEY): Promise<PortalMapping> {
  const raw = await call('app.option.get', { option: key })
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null
    }
  }
  return parsePortalSettings(parsed)
}

/** Persist the portal mapping to app.option (normalised before write — never store junk). */
export async function writeMapping(call: RestCall, mapping: unknown, key = SETTINGS_KEY): Promise<PortalMapping> {
  const normalised = parsePortalSettings(mapping)
  await call('app.option.set', { options: { [key]: JSON.stringify(normalised) } })
  return normalised
}
