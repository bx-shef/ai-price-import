import { ownerTypeCode } from './crmWrite'
import { neutralizeBb } from './chatNotify'

// Build a configurable activity («настраиваемое дело») for crm.activity.configurable.add.
// The app owns the layout (icon/header/body/footer + «открыть» button). Admin only
// toggles whether the source file is saved (docs/PROCESS.md §«Исходный файл и дело»).
//
// OWNER MODEL (owner ask): a дело has ONE owner (ownerTypeId/ownerId — the card it physically lives in);
// every other entity is an ADDITIONAL binding (crm.activity.binding.add), NOT a second activity. crm-sync
// makes the CLIENT COMPANY the owner when matched and binds the created entity to it (so the SAME дело
// shows in both timelines); with no company the created entity is the owner. This builder produces one
// activity's params + owns the layout; the extra binding is added by the caller (liveDeps). The «Открыть»
// button opens the created entity (useful from the company timeline); omitted when the entity IS the
// owner (no company — nothing else to jump to).
//
// SECURITY: the title/body lines carry the uploader-controlled supplier name / document
// fields, so — like the chat path (chatNotify) — they are BB-neutralised before they reach
// the CRM timeline, otherwise `[url=…]` / mentions could be injected into the activity.

/** CRM entity type id for a Company (RQ_INN counterparty) — the client company timeline owner. */
export const COMPANY_ENTITY_TYPE_ID = 4

export interface ActivityLayoutInput {
  /** Timeline owner TYPE — the created entity's type, or COMPANY_ENTITY_TYPE_ID for the company card. */
  ownerTypeId: number
  /** Timeline owner id — the created entity id, or the matched company id. */
  ownerId: number
  responsibleId?: number
  title: string
  /** Short lines shown in the activity body (e.g. counts, supplier). */
  lines: string[]
  /** Deep link the logo click + the (optional) «Открыть» button redirect to — the RELATED entity to
   *  jump to (the deal from the company's activity, or the company from the deal's activity). Always a
   *  same-portal relative path. */
  openPath: string
  /** Add the «Открыть» footer button (pointing at `openPath`). Omitted when there is nothing to jump
   *  to (a deal activity without a matched company). */
  showOpenButton?: boolean
  /** Label for the «Открыть» button (e.g. «Открыть сделку» / «Открыть компанию»). Default «Открыть». */
  openButtonTitle?: string
  /** Optional in-portal link to the archived SOURCE file on the Disk (its view URL). When set
   *  (and a valid same-portal relative path), a «Исходный файл» button is added to the timeline
   *  дело so the operator can open the original document (#129 follow-up). */
  sourceFileUrl?: string
}

/** Build the crm.activity.configurable.add params. Pure. */
export function buildConfigurableActivity(input: ActivityLayoutInput): Record<string, unknown> {
  // Footer allows at most TWO buttons — «Открыть» (opt) + «Исходный файл» (opt). Build only the
  // present ones; an all-absent footer is omitted (an empty buttons map adds no value).
  const buttons: Record<string, unknown> = {}
  if (input.showOpenButton) {
    buttons.open = {
      title: input.openButtonTitle ?? 'Открыть',
      type: 'primary',
      action: { type: 'redirect', uri: safeRelativePath(input.openPath) }
    }
  }
  // Link to the archived source file — only when the URL is a valid same-portal relative path (never
  // a scheme/protocol-relative URL that could redirect off-portal). It may carry a query
  // (`?IFRAME=Y&IFRAME_TYPE=SIDE_SLIDER`) — kept as-is; the guard only checks the path prefix.
  if (input.sourceFileUrl && isRelativePath(input.sourceFileUrl)) {
    buttons.sourceFile = {
      title: 'Исходный файл',
      type: 'secondary',
      action: { type: 'redirect', uri: input.sourceFileUrl }
    }
  }
  return {
    ownerTypeId: input.ownerTypeId,
    ownerId: input.ownerId,
    fields: {
      typeId: 'CONFIGURABLE',
      completed: 'Y',
      ...(input.responsibleId ? { responsibleId: input.responsibleId } : {})
    },
    layout: {
      icon: { code: 'document' },
      header: { title: neutralizeBb(input.title).slice(0, 255) },
      body: {
        // `logo` (LogoDto) is REQUIRED by B24 — a missing logo fails with «Поле logo в
        // BodyDto должно быть заполнено» (verified live on an OAuth portal; the webhook
        // path never reached this because configurable.add returns ERROR_WRONG_CONTEXT
        // over a webhook). `document` is a valid system logo code (crm.timeline.logo.list);
        // clicking it redirects to the related entity, same as the «Открыть» button.
        logo: { code: 'document', action: { type: 'redirect', uri: safeRelativePath(input.openPath) } },
        // B24 requires 1..20 blocks — guarantee at least one so an empty `lines` can't 400.
        blocks: Object.fromEntries(
          (input.lines.length ? input.lines : ['—']).slice(0, 10).map((text, i) => [
            `line${i}`,
            { type: 'text', properties: { value: neutralizeBb(String(text)).slice(0, 500) } }
          ])
        )
      },
      ...(Object.keys(buttons).length ? { footer: { buttons } } : {})
    }
  }
}

/** Whether a path is a safe same-portal relative path: a leading `/` followed by a char that is
 *  NOT `/` or `\`. Rejecting the backslash too matters because browsers normalize `/\host` → `//host`
 *  (protocol-relative) → an off-portal redirect; `[^/\\]` closes that. Shared with the URL
 *  normalizer (jobStore.detailUrlToRelative) so the SSRF-relevant guard lives in ONE place. */
export function isRelativePath(path: string): boolean {
  return /^\/[^/\\]/.test(path)
}

/** Guard: only allow a same-portal relative path (no scheme, no protocol-relative). */
export function safeRelativePath(path: string): string {
  return isRelativePath(path) ? path : '/crm/'
}

/** Portal path to open a created CRM entity (deal/quote/invoice/smart-process). */
export function entityOpenPath(entityTypeId: number, id: number): string {
  const code = ownerTypeCode(entityTypeId)
  if (code === 'L') return `/crm/lead/details/${id}/`
  if (code === 'D') return `/crm/deal/details/${id}/`
  if (code === 'Q') return `/crm/quote/show/${id}/`
  // Universal smart-process / smart-invoice detail path.
  return `/crm/type/${entityTypeId}/details/${id}/`
}

/** Portal path to open a company card. */
export function companyOpenPath(id: number): string {
  return `/crm/company/details/${id}/`
}
