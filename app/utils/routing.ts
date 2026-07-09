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

/** Convenience wrapper resolving against a whole portal mapping. */
export function resolveTargetForMapping(signals: RoutingSignals, mapping: PortalMapping): TargetRef {
  return resolveTarget(signals, mapping.routingRules, mapping.defaultTarget)
}
