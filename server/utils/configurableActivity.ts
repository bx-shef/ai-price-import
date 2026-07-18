import { ownerTypeCode } from './crmWrite'
import { neutralizeBb } from './chatNotify'

// Build a configurable activity («настраиваемое дело») for crm.activity.configurable.add.
// The app owns the layout (icon/header/body/footer + «открыть» button). Admin only
// toggles whether the source file is saved (docs/redesign/02 §«Исходный файл и дело»).
// SECURITY: the title/body lines carry the uploader-controlled supplier name / document
// fields, so — like the chat path (chatNotify) — they are BB-neutralised before they reach
// the CRM timeline, otherwise `[url=…]` / mentions could be injected into the activity.

export interface ActivityLayoutInput {
  entityTypeId: number
  ownerId: number
  responsibleId?: number
  title: string
  /** Short lines shown in the activity body (e.g. counts, supplier). */
  lines: string[]
  /** Deep link to open the created entity (path in portal). */
  openPath: string
}

/** Build the crm.activity.configurable.add params. Pure. */
export function buildConfigurableActivity(input: ActivityLayoutInput): Record<string, unknown> {
  return {
    ownerTypeId: input.entityTypeId,
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
        // clicking it opens the created entity, same as the footer button.
        logo: { code: 'document', action: { type: 'redirect', uri: safeRelativePath(input.openPath) } },
        // B24 requires 1..20 blocks — guarantee at least one so an empty `lines` can't 400.
        blocks: Object.fromEntries(
          (input.lines.length ? input.lines : ['—']).slice(0, 10).map((text, i) => [
            `line${i}`,
            { type: 'text', properties: { value: neutralizeBb(String(text)).slice(0, 500) } }
          ])
        )
      },
      footer: {
        buttons: {
          open: {
            title: 'Открыть',
            type: 'primary',
            action: { type: 'redirect', uri: safeRelativePath(input.openPath) }
          }
        }
      }
    }
  }
}

/** Guard: only allow a same-portal relative path (no scheme, no protocol-relative). */
export function safeRelativePath(path: string): string {
  return /^\/[^/]/.test(path) ? path : '/crm/'
}

/** Portal path to open a created CRM entity (deal/quote/invoice/smart-process). */
export function entityOpenPath(entityTypeId: number, id: number): string {
  const code = ownerTypeCode(entityTypeId)
  if (code === 'D') return `/crm/deal/details/${id}/`
  if (code === 'Q') return `/crm/quote/show/${id}/`
  // Universal smart-process / smart-invoice detail path.
  return `/crm/type/${entityTypeId}/details/${id}/`
}
