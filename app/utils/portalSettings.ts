import type { PortalMapping, RoutingRule, TargetRef } from '~/types/mapping'

// Parse raw app.option JSON into a validated PortalMapping with safe defaults.
// Never trust stored/user data — coerce and default. Pure (docs/redesign 02 §5).

const DEFAULT_TARGET: TargetRef = { entityTypeId: 2 } // deal

export function defaultMapping(): PortalMapping {
  return {
    article: { field: '', kind: 'text' },
    product: { by: 'article', onMissing: 'skip-warn' },
    units: { dictionary: {}, defaultCode: 796, autoCreate: false },
    saveFile: true,
    routingRules: [],
    defaultTarget: { ...DEFAULT_TARGET }
  }
}

function asTarget(v: unknown, fallback: TargetRef): TargetRef {
  const o = v as Record<string, unknown> | undefined
  const etid = Number(o?.entityTypeId)
  if (!Number.isFinite(etid) || etid <= 0) return fallback
  const categoryId = Number(o?.categoryId)
  return {
    entityTypeId: etid,
    ...(o?.categoryId != null && Number.isFinite(categoryId) ? { categoryId } : {}),
    ...(o?.stageId != null ? { stageId: String(o.stageId) } : {})
  }
}

function asRules(v: unknown): RoutingRule[] {
  if (!Array.isArray(v)) return []
  const out: RoutingRule[] = []
  for (const raw of v) {
    const o = raw as Record<string, unknown>
    const match = (o?.match ?? {}) as Record<string, unknown>
    const type = typeof match.type === 'string' ? match.type : undefined
    const keywords = Array.isArray(match.keywords) ? match.keywords.map(String).filter(Boolean) : undefined
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
        ? Object.fromEntries(Object.entries(units.dictionary as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), Number(v)]).filter(([, v]) => Number.isFinite(v as number)))
        : {},
      defaultCode: Number.isFinite(Number(units.defaultCode)) ? Number(units.defaultCode) : 796,
      autoCreate: units.autoCreate === true
    },
    saveFile: o.saveFile !== false,
    ...(typeof o.notifyChatId === 'string' ? { notifyChatId: o.notifyChatId } : {}),
    ...(typeof o.errorChatId === 'string' ? { errorChatId: o.errorChatId } : {}),
    routingRules: asRules(o.routingRules),
    defaultTarget: asTarget(o.defaultTarget, DEFAULT_TARGET)
  }
}
