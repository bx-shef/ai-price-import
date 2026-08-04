import type { TargetRef } from '~/types/mapping'

// Remember the target the employee picked BY HAND for the current import session (#349).
//
// Why remember at all: a person who feeds the app invoices all day sends them to the same place, and
// re-picking сущность → направление → стадию on every batch is pure friction.
//
// Why sessionStorage and not localStorage (owner's decision): the memory dies with the tab, so a
// shared office computer keeps nothing for the next person. What is stored is only IDENTIFIERS of a
// portal setting — no document, no counterparty, no file name — but the tab-lifetime rule is the same
// one the rest of this screen follows, and one rule is easier to keep honest than two.
//
// Why keyed by portal: sessionStorage is already per-tab, so two people never share a slot — but one
// tab CAN be navigated from one portal to another, and a направление id means nothing outside the
// portal it came from. The portal domain is the only identity the frame hands the client (`member_id`
// is deliberately server-side only), and it is exactly the scope that matters here.
//
// Pure + injected storage → unit-tested without a browser.

/** Minimal Storage surface used here (sessionStorage in the browser, a fake in tests). */
export interface TargetStore {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

/** Storage key for one portal. No portal yet (frame not ready) → a neutral slot, so a choice made
 *  before init cannot be attributed to the wrong portal later.
 *
 *  ⚠ Префикс сменился вместе с именем продукта (#412), и это забывает выбор направления во всех
 *  открытых вкладках у всех порталов — ровно один раз, на выкате. Терпимо: память живёт до
 *  закрытия вкладки by design, а следующая пачка сохранит выбор заново. Цена названа, чтобы её не
 *  искали как дефект. */
export function targetMemoryKey(portalDomain?: string | null): string {
  const d = String(portalDomain ?? '').trim().toLowerCase() || 'unknown'
  return `ai-price-import.target.${d}`
}

/** Serialise a target for storage. `null` clears the memory (employee went back to the default). */
export function writeTarget(store: TargetStore, key: string, target: TargetRef | null): void {
  try {
    if (!target || !(target.entityTypeId > 0)) {
      store.removeItem(key)
      return
    }
    // Only identifiers — captions/labels are re-read from the portal, never trusted from storage.
    store.setItem(key, JSON.stringify({
      entityTypeId: target.entityTypeId,
      ...(target.categoryId != null ? { categoryId: target.categoryId } : {}),
      ...(target.stageId ? { stageId: target.stageId } : {})
    }))
  } catch {
    // Storage can throw (private mode, quota). Remembering is a convenience — never break the import.
  }
}

/**
 * Read back a remembered target. Returns null on anything unexpected — corrupt JSON, wrong shape, a
 * non-positive entity type. The caller then falls back to the portal's default, which is also what
 * must happen when the направление/стадия has since been deleted or renamed: this function cannot
 * know that, so the CALLER validates the restored value against the live cascade before using it.
 */
export function readTarget(store: TargetStore, key: string): TargetRef | null {
  try {
    const raw = store.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<TargetRef> | null
    if (!parsed || typeof parsed !== 'object') return null
    const entityTypeId = Number(parsed.entityTypeId)
    if (!Number.isFinite(entityTypeId) || entityTypeId <= 0) return null
    const categoryId = Number(parsed.categoryId)
    const stageId = typeof parsed.stageId === 'string' && parsed.stageId ? parsed.stageId : undefined
    return {
      entityTypeId,
      ...(Number.isFinite(categoryId) && categoryId >= 0 ? { categoryId } : {}),
      ...(stageId ? { stageId } : {})
    } as TargetRef
  } catch {
    return null
  }
}
