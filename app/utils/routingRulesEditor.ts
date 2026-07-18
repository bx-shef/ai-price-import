import type { RoutingRule } from '~/types/mapping'
import { MAX_ROUTING_RULES, MAX_RULE_KEYWORDS } from './portalSettings'

// Pure record↔rows logic for the routing-rules editor (settings form). A routing rule sends a
// document to a target by its classified type and/or keywords (see routing.ts ruleMatches);
// first matching rule wins, else the default target. Keeping the conversion pure + tested keeps
// the Vue component thin. Mirrors parsePortalSettings' normalization (skip conditionless rules).

/** Document types the agent classifies (prompts/extract.ts) — offered as the rule's `type`. */
export const DOCUMENT_TYPES = ['накладная', 'счёт', 'КП', 'спецификация', 'прайс'] as const

/** One editable rule row: document type to match (empty = any), keywords (comma/newline text),
 *  the target entityTypeId (null while unset) and its `categoryId` (направление/воронка — now
 *  picked in the UI from the portal's crm.category.list). `stageId` is still not edited by the UI
 *  but rides along so a stage-scoped target (settable via app.option) survives the round-trip. */
export interface EditableRoutingRule {
  type: string
  keywords: string
  entityTypeId: number | null
  categoryId?: number
  stageId?: string
}

/** Split a keywords string (comma OR newline separated) into a clean array: trimmed, non-empty,
 *  deduped case-insensitively (keyword matching in routing.ts is homoglyph-folded substring).
 *  Capped at MAX_RULE_KEYWORDS — the same cap parsePortalSettings applies, so what the editor
 *  emits is not silently truncated on save. */
export function parseKeywords(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const part of (text ?? '').split(/[,\n]/)) {
    if (out.length >= MAX_RULE_KEYWORDS) break
    const k = part.trim()
    if (!k) continue
    const low = k.toLowerCase()
    if (seen.has(low)) continue
    seen.add(low)
    out.push(k)
  }
  return out
}

/** Editable rows ← stored rules. Keywords are joined for the textarea; a non-positive/absent
 *  target entityTypeId becomes null (the editor shows it unset); categoryId/stageId are carried. */
export function rulesToRows(rules: RoutingRule[] | null | undefined): EditableRoutingRule[] {
  const rs = Array.isArray(rules) ? rules : []
  return rs.map((r) => {
    const etid = r?.target?.entityTypeId
    const catId = r?.target?.categoryId
    const stageId = r?.target?.stageId
    return {
      type: r?.match?.type ?? '',
      keywords: Array.isArray(r?.match?.keywords) ? r.match.keywords.join(', ') : '',
      entityTypeId: Number.isInteger(etid) && (etid as number) > 0 ? etid as number : null,
      ...(Number.isInteger(catId) ? { categoryId: catId as number } : {}),
      ...(typeof stageId === 'string' && stageId ? { stageId } : {})
    }
  })
}

/** Stored rules ← editable rows. Drops a row that could never work: NO condition (no type AND
 *  no keywords → routing.ts ruleMatches returns false) OR an invalid target (non-positive
 *  entityTypeId → would create a markerless/duplicate-prone entity). Preserves categoryId/stageId
 *  on the target. Capped at MAX_ROUTING_RULES. Mirrors parsePortalSettings' skip-empty + caps, so
 *  what the editor writes survives the parse round-trip unchanged. */
export function rowsToRules(rows: EditableRoutingRule[]): RoutingRule[] {
  const out: RoutingRule[] = []
  for (const row of rows) {
    if (out.length >= MAX_ROUTING_RULES) break
    const type = (row.type ?? '').trim()
    const keywords = parseKeywords(row.keywords ?? '')
    if (!type && keywords.length === 0) continue // no condition → never matches, drop
    const etid = row.entityTypeId
    if (etid == null || !Number.isInteger(etid) || etid <= 0) continue // no valid target, drop
    out.push({
      match: { ...(type ? { type } : {}), ...(keywords.length ? { keywords } : {}) },
      target: {
        entityTypeId: etid,
        ...(Number.isInteger(row.categoryId) ? { categoryId: row.categoryId as number } : {}),
        ...(typeof row.stageId === 'string' && row.stageId ? { stageId: row.stageId } : {})
      }
    })
  }
  return out
}
