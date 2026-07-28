import type { RoutingRule } from '~/types/mapping'
import { MAX_ROUTING_RULES, MAX_RULE_KEYWORDS } from './portalSettings'

// Pure record↔rows logic for the routing-rules editor (settings form). A routing rule sends a document
// to a target by KEYWORDS (owner ask: «убери Тип — хватит слов»); first matching rule wins, else the
// default target. The stored `match.type` is no longer edited here — a rule the UI produces matches by
// keywords only. (routing.ts still honours a stored `type` at runtime for backward compatibility, but the
// editor neither shows nor writes it.) Keeping the conversion pure + tested keeps the Vue component thin.

/** One editable rule row: keywords (comma/newline text) + the target (entityTypeId while unset = null,
 *  plus its `categoryId`/`stageId`, all now picked via the shared TargetPicker). */
export interface EditableRoutingRule {
  keywords: string
  entityTypeId: number | null
  categoryId?: number
  stageId?: string
}

/** Split a keywords string (comma OR newline separated) into a clean array: trimmed, non-empty,
 *  deduped case-insensitively (keyword matching in routing.ts is homoglyph-folded substring).
 *  Capped at MAX_RULE_KEYWORDS — the same cap parsePortalSettings applies. */
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

/** Editable rows ← stored rules. Keywords are joined for the input; a non-positive/absent target
 *  entityTypeId becomes null (unset); categoryId/stageId are carried. A stored `match.type` is ignored
 *  (the editor is keyword-only now). */
export function rulesToRows(rules: RoutingRule[] | null | undefined): EditableRoutingRule[] {
  const rs = Array.isArray(rules) ? rules : []
  return rs.map((r) => {
    const etid = r?.target?.entityTypeId
    const catId = r?.target?.categoryId
    const stageId = r?.target?.stageId
    return {
      keywords: Array.isArray(r?.match?.keywords) ? r.match.keywords.join(', ') : '',
      entityTypeId: Number.isInteger(etid) && (etid as number) > 0 ? etid as number : null,
      ...(Number.isInteger(catId) ? { categoryId: catId as number } : {}),
      ...(typeof stageId === 'string' && stageId ? { stageId } : {})
    }
  })
}

/** Stored rules ← editable rows. Drops a row that could never work: NO keywords (→ ruleMatches returns
 *  false) OR an invalid target (non-positive entityTypeId). Preserves categoryId/stageId. Capped at
 *  MAX_ROUTING_RULES. Mirrors parsePortalSettings' skip-empty + caps. */
export function rowsToRules(rows: EditableRoutingRule[]): RoutingRule[] {
  const out: RoutingRule[] = []
  for (const row of rows) {
    if (out.length >= MAX_ROUTING_RULES) break
    const keywords = parseKeywords(row.keywords ?? '')
    if (keywords.length === 0) continue // no keyword condition → never matches, drop
    const etid = row.entityTypeId
    if (etid == null || !Number.isInteger(etid) || etid <= 0) continue // no valid target, drop
    out.push({
      match: { keywords },
      target: {
        entityTypeId: etid,
        ...(Number.isInteger(row.categoryId) ? { categoryId: row.categoryId as number } : {}),
        ...(typeof row.stageId === 'string' && row.stageId ? { stageId: row.stageId } : {})
      }
    })
  }
  return out
}
