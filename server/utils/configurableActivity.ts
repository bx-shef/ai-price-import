import { ownerTypeCode } from './crmWrite'

// Build a configurable activity («настраиваемое дело») for crm.activity.configurable.add.
// The app owns the layout (icon/header/body/footer + «открыть» button). Admin only
// toggles whether the source file is saved (docs/redesign/02 §«Исходный файл и дело»).

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
      header: { title: input.title.slice(0, 255) },
      body: {
        blocks: Object.fromEntries(
          input.lines.slice(0, 10).map((text, i) => [
            `line${i}`,
            { type: 'text', properties: { value: String(text).slice(0, 500) } }
          ])
        )
      },
      footer: {
        buttons: {
          open: {
            title: 'Открыть',
            type: 'primary',
            action: { type: 'redirect', uri: input.openPath }
          }
        }
      }
    }
  }
}

/** Portal path to open a created CRM entity (deal/quote/invoice/smart-process). */
export function entityOpenPath(entityTypeId: number, id: number): string {
  const code = ownerTypeCode(entityTypeId)
  if (code === 'D') return `/crm/deal/details/${id}/`
  if (code === 'Q') return `/crm/quote/show/${id}/`
  // Universal smart-process / smart-invoice detail path.
  return `/crm/type/${entityTypeId}/details/${id}/`
}
