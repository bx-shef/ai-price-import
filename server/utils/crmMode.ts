import type { RestCall } from './b24Rest'

// Portal CRM mode (crm.settings.mode.get / crm.enum.settings.mode): the portal runs either the CLASSIC
// CRM (with leads) or the SIMPLE CRM (without leads). In the simple mode a created lead is auto-converted
// on the spot (the lead is pointless), so crm-sync must NOT route a document to a lead there — it
// redirects a lead target to a deal instead (see crmSyncCore). Live-verified: a lead created on a
// simple-mode portal immediately reads back as `CONVERTED`.

export const CRM_MODE_CLASSIC = 1 // Классическая CRM — leads enabled
export const CRM_MODE_SIMPLE = 2 // Простая CRM — NO leads

/** Fetch the portal's CRM mode (crm.settings.mode.get → 1 classic / 2 simple). RestCall unwraps to
 *  `result` (a bare integer). Returns null on any failure so the caller can fail-open. */
export async function fetchCrmMode(call: RestCall): Promise<number | null> {
  try {
    const res = await call('crm.settings.mode.get', {})
    const n = Number(res)
    return Number.isInteger(n) ? n : null
  } catch {
    return null
  }
}

/** Whether leads are usable on the portal (classic mode). ONLY the explicit simple mode (2) disables
 *  leads; an unknown/failed read (null) → true (FAIL-OPEN: a transient read failure must not silently
 *  block lead creation on a portal that does use leads). */
export function leadsEnabled(mode: number | null): boolean {
  return mode !== CRM_MODE_SIMPLE
}
