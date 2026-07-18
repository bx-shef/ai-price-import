import type { PortalMapping, RoutingRule, TargetRef } from '~/types/mapping'
import { foldHomoglyphs } from './homoglyph'

/** Signals used to resolve the import target. */
export interface RoutingSignals {
  /** Document type classified by the agent (may be undefined). */
  documentType?: string
  /** Full document text (for keyword matching). */
  text?: string
  /** Manual override chosen by the user next to the file. */
  manualOverride?: TargetRef
}

/** Does a single rule match the signals? */
export function ruleMatches(rule: RoutingRule, signals: RoutingSignals): boolean {
  const { type, keywords } = rule.match
  // A rule with no conditions never matches (avoids accidental catch-all).
  if (!type && (!keywords || keywords.length === 0)) return false

  if (type) {
    if (!signals.documentType) return false
    if (foldHomoglyphs(type.trim()) !== foldHomoglyphs(signals.documentType.trim())) return false
  }
  if (keywords && keywords.length) {
    const haystack = foldHomoglyphs(signals.text ?? '')
    const hit = keywords.some((k) => {
      const needle = foldHomoglyphs(k.trim())
      return needle.length > 0 && haystack.includes(needle)
    })
    if (!hit) return false
  }
  return true
}

/**
 * Resolve the import target by three priority levels:
 *  1. manual override next to the file — always wins;
 *  2. first matching routing rule (in order);
 *  3. default target (fallback, required).
 * See docs/redesign/02-target-architecture.md §5.
 */
export function resolveTarget(
  signals: RoutingSignals,
  rules: RoutingRule[],
  defaultTarget: TargetRef
): TargetRef {
  if (signals.manualOverride) return signals.manualOverride
  for (const rule of rules) {
    if (ruleMatches(rule, signals)) return rule.target
  }
  return defaultTarget
}

/** Hard fallback target — deal (entityTypeId 2), direction 0 (Default pipeline, always exists).
 *  Used when the default target itself points at a deleted funnel, and as the parser's fallback
 *  when app.option has an empty/broken default target. See docs §5 «Fallback при удалённом направлении». */
export const FALLBACK_TARGET: TargetRef = { entityTypeId: 2, categoryId: 0 }

/**
 * Guard the resolved target against a DELETED funnel (admin removed a воронка in CRM but never fixed
 * settings, so a stale categoryId lingers and crm.item.add would reject it). Walks the fallback
 * chain and returns the first target whose direction still exists on the portal:
 *   resolved (rule/manual/default) → default target → FALLBACK_TARGET (deal / direction 0).
 * A target with NO categoryId is valid as-is (the entity's own default funnel). `listCategoryIds`
 * returns the valid category ids for an entity type (crm.category.list); it is called only when a
 * target pins a categoryId. FAIL-OPEN: if the list can't be read (throws) or is empty (e.g. the
 * entity has no funnels), the target is used as-is — a read hiccup must never block an import.
 */
export async function resolveValidTarget(
  resolved: TargetRef,
  defaultTarget: TargetRef,
  listCategoryIds: (entityTypeId: number) => Promise<number[]>
): Promise<TargetRef> {
  // De-dupe the chain by (entityTypeId, categoryId) so we don't re-check the same target twice.
  const seen = new Set<string>()
  const chain = [resolved, defaultTarget, FALLBACK_TARGET].filter((t) => {
    const key = `${t.entityTypeId}:${t.categoryId ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  for (const target of chain) {
    if (target.categoryId == null) return target // no direction pinned → entity's default funnel
    let ids: number[]
    try {
      ids = await listCategoryIds(target.entityTypeId)
    } catch {
      return target // fail-open: can't verify → use as-is (don't block the import)
    }
    if (ids.length === 0) return target // fail-open: no funnels to check against
    if (ids.includes(target.categoryId)) return target // direction still exists
    // else: funnel deleted → try the next target in the chain
  }
  return FALLBACK_TARGET
}

/** Convenience wrapper resolving against a whole portal mapping. */
export function resolveTargetForMapping(signals: RoutingSignals, mapping: PortalMapping): TargetRef {
  return resolveTarget(signals, mapping.routingRules, mapping.defaultTarget)
}
