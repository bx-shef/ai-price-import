import type { RestCall } from './b24Rest'

// Smart-process (СПА) types via crm.type.list, so the settings/import UI can offer them as a NAMED list
// (like Лид/Сделка/Смарт-счёт) instead of a raw entityTypeId input. Each type carries whether it uses
// directions (isCategoriesEnabled) and stages (isStagesEnabled) — the pickers show those ONLY when the
// process actually uses them (owner ask). Pure over RestCall (DI).
//
// crm.type.list returns `{ types: [{ entityTypeId, title, isCategoriesEnabled:'Y'/'N',
// isStagesEnabled:'Y'/'N', isLinkWithProductsEnabled:'Y'/'N', ... }] }` (live-verified). We keep only
// dynamic SPA types (entityTypeId ≥ 1000) that CAN hold product rows (isLinkWithProductsEnabled='Y') —
// this app imports товарные позиции, so a products-off SPA (e.g. «Договоры») is NOT a valid target
// (crm.item.productrow.set would fail), and offering it would be a footgun. Smart-invoice (31) is a
// fixed preset (always has products); deal/lead are static.

export interface SmartProcessType {
  entityTypeId: number
  title: string
  /** Whether the process uses directions (воронки) — the direction picker shows only when true. */
  hasCategories: boolean
  /** Whether the process uses stages — the stage picker shows only when true. */
  hasStages: boolean
}

const yes = (v: unknown): boolean => v === 'Y' || v === true || v === 1

/** Fetch the portal's smart-process types (entityTypeId ≥ 1000), sorted by title. Never throws (→ [] on
 *  any failure) so the picker just falls back to «no SPA options». */
export async function fetchSmartProcessTypes(call: RestCall): Promise<SmartProcessType[]> {
  let res: unknown
  try {
    res = await call('crm.type.list', {})
  } catch {
    return []
  }
  const types = (res as { types?: unknown } | undefined)?.types
  const rows = Array.isArray(types) ? types as Array<Record<string, unknown>> : []
  return rows
    .map(t => ({
      entityTypeId: Number(t.entityTypeId),
      title: String(t.title ?? '').trim(),
      hasCategories: yes(t.isCategoriesEnabled),
      hasStages: yes(t.isStagesEnabled),
      hasProducts: yes(t.isLinkWithProductsEnabled)
    }))
    // Dynamic SPA (≥1000), titled, and able to hold product rows (else товары can't be written there).
    .filter(t => Number.isInteger(t.entityTypeId) && t.entityTypeId >= 1000 && t.title && t.hasProducts)
    .map(({ entityTypeId, title, hasCategories, hasStages }) => ({ entityTypeId, title, hasCategories, hasStages }))
    .sort((a, b) => a.title.localeCompare(b.title, 'ru'))
}

/**
 * Whether the portal actually supports SMART INVOICES (entityTypeId 31). Unlike smart processes, the
 * invoice is a fixed preset that the picker offered unconditionally — on a portal where invoices are
 * off the employee picked it and got the portal's raw «Сущность CRM не поддерживается» at import
 * time (#269). `crm.item.fields` is the cheapest read-only probe: it succeeds when the type exists.
 *
 * Returns `null` when the answer is inconclusive (network/auth blip) — the caller keeps offering the
 * option (fail-open), because hiding a working target is worse than the old behaviour.
 */
export async function probeSmartInvoiceEnabled(call: RestCall): Promise<boolean | null> {
  try {
    const res = await call('crm.item.fields', { entityTypeId: SMART_INVOICE_ENTITY_TYPE_ID })
    return !!(res as { fields?: unknown } | undefined)?.fields
  } catch (e) {
    // Only an explicit «this type is not supported» is a definitive NO. A bare NOT_FOUND is NOT
    // enough: B24 returns it for many reasons, and treating it as «нет смарт-счетов» would HIDE a
    // working target — the opposite of the fail-open policy this probe is built on.
    const msg = e instanceof Error ? e.message : String(e)
    return /не\s+поддерживается|not\s+supported/i.test(msg) ? false : null
  }
}

/** Smart invoice — a fixed system type, not a dynamic smart process. */
export const SMART_INVOICE_ENTITY_TYPE_ID = 31
