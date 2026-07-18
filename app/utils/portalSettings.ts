import type { PortalMapping, RoutingRule, TargetRef } from '~/types/mapping'
import { FALLBACK_TARGET } from './routing'

// Parse raw app.option JSON into a validated PortalMapping with safe defaults.
// Never trust stored/user data — coerce and default. Pure (docs/redesign 02 §5).

// Fallback default target when app.option has none / a broken one: deal, direction 0 (Default
// pipeline) — the same hard anchor crm-sync falls back to when a funnel is deleted (routing.ts).
const DEFAULT_TARGET: TargetRef = FALLBACK_TARGET

// DoS bounds (#83): app.option is admin-controlled, so a bloated blob (huge routingRules /
// unit dictionary) would pin CPU/memory while a worker parses it once per job. Cap the
// input BEFORE the loops — silently truncate rather than choke (a real config never nears these).
// Exported so the settings-form editor (routingRulesEditor) enforces the SAME caps it will be
// parsed against — otherwise an overflowing editor state is silently truncated on save.
export const MAX_ROUTING_RULES = 200
export const MAX_RULE_KEYWORDS = 100
const MAX_UNIT_DICT_ENTRIES = 1000

export function defaultMapping(): PortalMapping {
  return {
    article: { field: '', kind: 'text' },
    product: { by: 'article', onMissing: 'skip-warn' },
    units: { dictionary: {}, defaultCode: 796, autoCreate: false },
    // Opt-in (default OFF): archiving raw client documents onto the portal's common Disk is a
    // privacy choice on a multitenant OAuth app — a tenant that never configured it should not
    // have client files copied to its Disk. The admin turns it on in settings.
    saveFile: false,
    routingRules: [],
    defaultTarget: { ...DEFAULT_TARGET }
  }
}

function asTarget(v: unknown, fallback: TargetRef): TargetRef {
  const o = v as Record<string, unknown> | undefined
  const etid = Number(o?.entityTypeId)
  // A B24 entityTypeId is a positive INTEGER. Reject non-integers too, so the parse layer and the
  // settings-form editor (rowsToRules requires an integer) agree — no rule silently drops on save.
  if (!Number.isInteger(etid) || etid <= 0) return fallback
  const categoryId = Number(o?.categoryId)
  const stageId = typeof o?.stageId === 'string' ? o.stageId.trim() : ''
  return {
    entityTypeId: etid,
    // Integer AND ≥0 so this parser, the editor (rulesToRows) and the manual-target validator
    // (parseManualTarget) share ONE gate — a float/negative id can't pass one layer and be dropped
    // by another (categoryId 0 = the default deal pipeline, a valid selection).
    ...(o?.categoryId != null && Number.isInteger(categoryId) && categoryId >= 0 ? { categoryId } : {}),
    // String-only + trim + cap, matching parseManualTarget (a non-string stageId is meaningless).
    ...(stageId ? { stageId: stageId.slice(0, 100) } : {})
  }
}

function asRules(v: unknown): RoutingRule[] {
  if (!Array.isArray(v)) return []
  const out: RoutingRule[] = []
  for (const raw of v.slice(0, MAX_ROUTING_RULES)) { // DoS cap (#83)
    const o = raw as Record<string, unknown>
    const match = (o?.match ?? {}) as Record<string, unknown>
    const type = typeof match.type === 'string' ? match.type : undefined
    const keywords = Array.isArray(match.keywords) ? match.keywords.slice(0, MAX_RULE_KEYWORDS).map(String).filter(Boolean) : undefined
    if (!type && (!keywords || keywords.length === 0)) continue // skip empty condition
    out.push({ match: { ...(type ? { type } : {}), ...(keywords ? { keywords } : {}) }, target: asTarget(o?.target, DEFAULT_TARGET) })
  }
  return out
}

export function parsePortalSettings(raw: unknown): PortalMapping {
  const base = defaultMapping()
  if (!raw || typeof raw !== 'object') return base
  const o = raw as Record<string, unknown>
  const art = (o.article ?? {}) as Record<string, unknown>
  const prod = (o.product ?? {}) as Record<string, unknown>
  const units = (o.units ?? {}) as Record<string, unknown>
  return {
    article: {
      field: typeof art.field === 'string' ? art.field : '',
      kind: art.kind === 'string' ? 'string' : 'text',
      ...(typeof art.delimiter === 'string' ? { delimiter: art.delimiter } : {})
    },
    product: {
      by: prod.by === 'name' ? 'name' : 'article',
      onMissing: prod.onMissing === 'create' || prod.onMissing === 'freeform' ? prod.onMissing : 'skip-warn'
    },
    units: {
      dictionary: units.dictionary && typeof units.dictionary === 'object'
        ? Object.fromEntries(Object.entries(units.dictionary as Record<string, unknown>).slice(0, MAX_UNIT_DICT_ENTRIES).map(([k, v]) => [k.toLowerCase(), Number(v)]).filter(([, v]) => Number.isInteger(v as number) && (v as number) > 0)) // DoS cap (#83); a measure code is a positive integer (aligned with the editor's rowsToDictionary)
        : {},
      defaultCode: Number.isFinite(Number(units.defaultCode)) ? Number(units.defaultCode) : 796,
      autoCreate: units.autoCreate === true
    },
    saveFile: o.saveFile === true, // opt-in — only an explicit `true` enables Disk archiving
    ...(typeof o.notifyChatId === 'string' ? { notifyChatId: o.notifyChatId } : {}),
    ...(typeof o.errorChatId === 'string' ? { errorChatId: o.errorChatId } : {}),
    routingRules: asRules(o.routingRules),
    defaultTarget: asTarget(o.defaultTarget, DEFAULT_TARGET)
  }
}
