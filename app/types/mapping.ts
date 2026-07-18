// Per-portal configuration (mapping). Stored in app.option via server-side REST.
// Pure types — see docs/redesign/02-target-architecture.md §5.

/** CRM entity kinds the import can create.
 *  - lead (entityTypeId 1, #135): carries originId/originatorId (marker), so idempotent; the
 *    supplier nuance (found → companyId / not found → companyTitle) lives in crm-sync.
 *  - quote (КП, entityTypeId 7) is intentionally NOT a target — no filterable external-marker
 *    field, AND an incoming counterparty document has nothing to import into an outgoing offer
 *    (owner decision, #135). */
export type TargetEntityKind = 'lead' | 'deal' | 'smart-process' | 'invoice'

/** Bitrix24 entityTypeId helpers: deal=2, invoice(smart)=31, smart-process >= 1000.
 *  (quote=7 is not a target — see #135.) */
export interface TargetRef {
  entityTypeId: number
  /** Direction (voronka) — crm.category.* id. */
  categoryId?: number
  /** Stage id within the category. */
  stageId?: string
}

/** A routing rule: condition -> target. First matching rule wins. */
export interface RoutingRule {
  match: {
    /** Match on the classified document type (agent), case/locale-insensitive. */
    type?: string
    /** Match if any keyword occurs in the document text (deterministic). */
    keywords?: string[]
  }
  target: TargetRef
}

/** How the supplier-article field on a catalog product is shaped. */
export interface ArticleFieldConfig {
  /** Catalog property code holding the supplier article(s). */
  field: string
  /** 'text' → one article per line; 'string' → delimiter-separated. */
  kind: 'text' | 'string'
  /** Required when kind === 'string' — admin-chosen delimiter. */
  delimiter?: string
}

/** Product lookup strategy. */
export interface ProductLookupConfig {
  /** 'article' → by supplier article; 'name' → by full product name. */
  by: 'article' | 'name'
  /** What to do when no product matched. */
  onMissing: 'create' | 'skip-warn' | 'freeform'
}

/** Unit-of-measure mapping (see Q11). */
export interface UnitsConfig {
  /** Lower-cased document unit synonym -> catalog.measure code. */
  dictionary: Record<string, number>
  /** Default measure code when nothing matched. */
  defaultCode: number
  /** Auto-create a measure when missing (and report as an error). */
  autoCreate: boolean
}

/** Full per-portal mapping. */
export interface PortalMapping {
  article: ArticleFieldConfig
  product: ProductLookupConfig
  units: UnitsConfig
  /** Whether to save the source file to Disk + attach to the activity. */
  saveFile: boolean
  /** Notification / error chat dialog ids. */
  notifyChatId?: string
  errorChatId?: string
  /** Ordered routing rules (first match wins). */
  routingRules: RoutingRule[]
  /** Fallback target when no rule matched (required). */
  defaultTarget: TargetRef
}
