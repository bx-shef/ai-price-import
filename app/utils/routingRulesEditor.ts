import type { RoutingRule } from '~/types/mapping'

// Pure record↔rows logic for the routing-rules editor (settings form). A routing rule sends a
// document to a target by its classified type and/or keywords (see routing.ts ruleMatches);
// first matching rule wins, else the default target. Keeping the conversion pure + tested keeps
// the Vue component thin. Mirrors parsePortalSettings' normalization (skip conditionless rules).

/** Document types the agent classifies (prompts/extract.ts) — offered as the rule's `type`. */
export const DOCUMENT_TYPES = ['накладная', 'счёт', 'КП', 'спецификация', 'прайс'] as const

/** One editable rule row: document type to match (empty = any), keywords (comma/newline text),
 *  and the target entityTypeId (null while unset). */
export interface EditableRoutingRule {
  type: string
  keywords: string
  entityTypeId: number | null
}

/** Split a keywords string (comma OR newline separated) into a clean array: trimmed, non-empty,
 *  deduped case-insensitively (keyword matching in routing.ts is homoglyph-folded substring). */
export function parseKeywords(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const part of (text ?? '').split(/[,\n]/)) {
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
 *  target entityTypeId becomes null (the editor shows it unset). */
export function rulesToRows(rules: RoutingRule[] | null | undefined): EditableRoutingRule[] {
  const rs = Array.isArray(rules) ? rules : []
  return rs.map((r) => {
    const etid = r?.target?.entityTypeId
    return {
      type: r?.match?.type ?? '',
      keywords: Array.isArray(r?.match?.keywords) ? r.match.keywords.join(', ') : '',
      entityTypeId: Number.isInteger(etid) && (etid as number) > 0 ? etid as number : null
    }
  })
}

/** Stored rules ← editable rows. Drops a row that could never work: NO condition (no type AND
 *  no keywords → routing.ts ruleMatches returns false) OR an invalid target (non-positive
 *  entityTypeId → would create a markerless/duplicate-prone entity). Mirrors parsePortalSettings'
 *  skip-empty, so what the editor writes survives the parse round-trip unchanged. */
export function rowsToRules(rows: EditableRoutingRule[]): RoutingRule[] {
  const out: RoutingRule[] = []
  for (const row of rows) {
    const type = (row.type ?? '').trim()
    const keywords = parseKeywords(row.keywords ?? '')
    if (!type && keywords.length === 0) continue // no condition → never matches, drop
    const etid = row.entityTypeId
    if (etid == null || !Number.isInteger(etid) || etid <= 0) continue // no valid target, drop
    out.push({
      match: { ...(type ? { type } : {}), ...(keywords.length ? { keywords } : {}) },
      target: { entityTypeId: etid }
    })
  }
  return out
}
