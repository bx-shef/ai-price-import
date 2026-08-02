import type { PortalMapping, RoutingRule, TargetRef } from '~/types/mapping'
import { FALLBACK_TARGET } from './routing'
import { normalizeUnitKey } from './measureCreate'

// Parse raw app.option JSON into a validated PortalMapping with safe defaults.
// Never trust stored/user data — coerce and default. Pure (docs/PROCESS.md).

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
    saveFile: true, // #328: по умолчанию ВКЛЮЧЕНО — файл привязывается к делу (решение владельца)
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
      // Product creation was removed. A portal that had the legacy `'create'` stored degrades to
      // `'freeform'` (keep the line as a free-form position — the closest non-dropping behaviour),
      // anything else → `'skip-warn'` (the default).
      onMissing: prod.onMissing === 'freeform' || prod.onMissing === 'create' ? 'freeform' : 'skip-warn'
    },
    units: {
      dictionary: units.dictionary && typeof units.dictionary === 'object'
        ? Object.fromEntries(Object.entries(units.dictionary as Record<string, unknown>).slice(0, MAX_UNIT_DICT_ENTRIES).map(([k, v]) => [normalizeUnitKey(k), Number(v)]).filter(([k, v]) => k !== '' && Number.isInteger(v as number) && (v as number) > 0)) // DoS cap (#83); key canonicalised (same as editor rowsToDictionary + resolveMeasure); code a positive integer
        : {},
      defaultCode: Number.isFinite(Number(units.defaultCode)) ? Number(units.defaultCode) : 796,
      autoCreate: units.autoCreate === true
    },
    // #328: включено по умолчанию (решение владельца) — исходник на Диске портала нужен, чтобы
    // привязать его к делу таймлайна. Явный `false` выключает; всё остальное (нет поля, мусор)
    // читается как «включено», иначе портал со старыми настройками молча потерял бы файл в деле.
    saveFile: o.saveFile !== false,
    ...(typeof o.notifyChatId === 'string' ? { notifyChatId: o.notifyChatId } : {}),
    ...(typeof o.errorChatId === 'string' ? { errorChatId: o.errorChatId } : {}),
    routingRules: asRules(o.routingRules),
    defaultTarget: asTarget(o.defaultTarget, DEFAULT_TARGET),
    ...asSavings(o.savings)
  }
}

/** Hourly rate for the money estimate (#270). Anything not a sane positive number ⇒ the key is
 *  omitted entirely, so the dashboard falls back to «time only» rather than printing a garbage
 *  amount. Capped: the figure is rendered as-is, and a rate of 1e9 would produce nonsense. */
export const MAX_SAVINGS_RATE = 1_000_000
function asSavings(v: unknown): { savings?: { ratePerHour: number } } {
  const rate = Number((v as Record<string, unknown> | undefined)?.ratePerHour)
  if (!Number.isFinite(rate) || rate <= 0) return {}
  return { savings: { ratePerHour: Math.min(Math.round(rate * 100) / 100, MAX_SAVINGS_RATE) } }
}

/** Whether the admin has configured ANYTHING beyond the pristine defaults. Returns false only when
 *  the mapping is byte-for-byte the out-of-the-box default (defaultMapping) — i.e. the portal admin
 *  has never touched settings. The in-portal home page uses this to nudge an admin to set things up
 *  (and to tell a non-admin the app isn't configured yet) before the first import. Pure — any single
 *  meaningful setting (article field, a chat, a routing rule, a custom target/strategy/unit) flips it
 *  to true, so a partially-configured portal is never falsely reported as «not configured». */
export function isPortalConfigured(m: PortalMapping): boolean {
  if (m.article.field.trim()) return true
  if (m.notifyChatId || m.errorChatId) return true
  if (m.routingRules.length > 0) return true
  if (Object.keys(m.units.dictionary).length > 0) return true
  // `saveFile` НЕ считается признаком настройки (#328): с тех пор как хранение исходника включено
  // по умолчанию, оно есть у нетронутого портала — и «настроено» загоралось бы у всех сразу,
  // а баннер «сначала настройте приложение» не показался бы никому.
  if (m.product.by !== 'article' || m.product.onMissing !== 'skip-warn') return true
  if (m.units.defaultCode !== 796 || m.units.autoCreate) return true
  // Default target moved off the fallback anchor (deal / direction 0 / no stage)? categoryId 0 IS
  // the anchor (default deal pipeline), so only a non-zero funnel or a set stage counts as configured.
  const t = m.defaultTarget
  if (t.entityTypeId !== DEFAULT_TARGET.entityTypeId || (t.categoryId ?? 0) !== 0 || t.stageId) return true
  // `savings.ratePerHour` is deliberately NOT counted (#270): this flag gates the whole app on
  // «can we import at all», and an hourly rate for the savings widget says nothing about that.
  // Counting it would let a cosmetic setting unlock an unmapped portal.
  return false
}
