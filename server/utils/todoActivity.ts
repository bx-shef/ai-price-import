import { ownerTypeCode } from './crmWrite'
import { neutralizeBb } from './chatNotify'

// Дело таймлайна — УНИВЕРСАЛЬНОЕ (`crm.activity.todo.add`), не конфигурируемое (#328, решение
// владельца 06.08.2026 после живой разведки на портале b24-hrbvzq).
//
// ПОЧЕМУ СМЕНИЛСЯ НОСИТЕЛЬ. Конфигурируемое дело давало свою иконку, блоки и кнопки подвала, но
// НЕ НЕСЁТ ФАЙЛОВ вовсе, а прикрепить к делу файл, уже лежащий на Диске, по его id по REST нельзя
// нигде (разбор ядра: поле `diskfile` проходит через `tryInternalizeDiskFileField`, где элемент без
// ключа `fileData` просто пропускается — отсюда «успех, а файла нет» у пятнадцати проверенных форм).
// Поэтому документ жил ОТДЕЛЬНОЙ копией на Диске, а дело несло на неё ссылку. Универсальное дело
// носит файл по-настоящему, и вместе с ним даёт цвет, срок и напоминание — то есть три сигнала
// вместо одного. Плата названа вслух: **иконка у него захардкожена** (`ToDo::getIconCode()`),
// кнопок подвала нет, а блоки превращаются в размеченное описание.
//
// ЧТО ЧЕМ ЗАМЕНЕНО:
//   значок «document»/«attention» → ЦВЕТ (зелёный/розовый) + завершённость;
//   кнопка «Открыть»              → подписанный блок «Сделка: Открыть карточку»;
//   блок-ссылка «Исходный файл»   → НАСТОЯЩЕЕ вложение (`FILES`), Диск больше не участвует (#458).
//
// БЕЗОПАСНОСТЬ: имя поставщика и тексты предупреждений приходят из документа, то есть их
// контролирует загрузивший. Разметка тут BB, поэтому нейтрализация BB-скобок ОБЯЗАТЕЛЬНА и по
// более жёсткой причине, чем раньше: у конфигурируемого дела блок был текстовым и разметку не
// разбирал, а здесь `[URL=…]` из документа стал бы настоящей ссылкой в карточке клиента.

/** CRM entity type id for a Company (RQ_INN counterparty) — the client company timeline owner. */
export const COMPANY_ENTITY_TYPE_ID = 4

/**
 * Цвета дела (`colorId` у `crm.activity.todo.add` — СТРОКИ).
 *
 * ⚠ Снято из палитры ядра вместе с оттенками, а не угадано: `4` = #8FB035 (зелёный), `7` = #DA7790
 * (розовый). Проверить оттенок программно нечем в принципе — REST отдаёт сохранённое значение, но
 * не то, как оно выглядит; поэтому пара подтверждена человеком на витрине (`pnpm probe:todo`).
 * ⚠ Жёлтый — это `default`, и цифрового номера у него НЕТ: не передав `colorId` вовсе, получим
 * жёлтое дело. То есть «цвет не задан» и «цвет жёлтый» на портале неотличимы, и забытый параметр
 * читался бы как осознанный выбор — поэтому цвет ставится всегда.
 */
export const TODO_COLOR_CLEAN = '4'
export const TODO_COLOR_ISSUES = '7'

/**
 * Тип описания: `3` — BB-код.
 *
 * ⚠ Ставится ОТДЕЛЬНЫМ вызовом `crm.activity.update`: у `todo.add` параметра под тип описания нет,
 * а дефолт — `2` (HTML). При дефолте BB-разметка показывается ИСХОДНИКОМ, то есть человек читает
 * «[B]Поставщик:[/B]» буквально в каждом деле. HTML отвергнут решением владельца — живьём он не
 * отрисовался.
 */
export const DESCRIPTION_TYPE_BB = 3

/** Насколько отодвинут срок у дела с замечаниями (минуты). У чистого импорта срок — «сейчас». */
export const ISSUE_DEADLINE_MINUTES = 15

/**
 * Напоминание у дела с замечаниями — за 0 минут до срока (решение владельца).
 *
 * ⚠ Только у дела С ЗАМЕЧАНИЯМИ. Чистый импорт закрыт и напоминать по нему не о чем: уведомление
 * о том, что всё хорошо, обесценивает уведомления вообще.
 */
export const ISSUE_PING_OFFSETS = [0]

/** Сколько предупреждений печатаем списком. Ограничение по здравому смыслу, а не по контракту:
 *  у конфигурируемого дела был жёсткий предел в 20 блоков на всё тело, у описания его нет. Но
 *  список на сотню строк — это не отчёт, а стена, и его всё равно никто не дочитает. */
export const MAX_ACTIVITY_PROBLEMS = 12

export interface ActivityBodyInput {
  supplierName?: string
  /** Компания-контрагент: её id делает имя поставщика ссылкой на карточку. */
  companyId?: number | null
  rowCount: number
  /** Сколько строк связано с каталогом. `null` — не считали (показывать нечего). */
  matchedCount?: number | null
  /** Готовая подпись суммы («10 320,00 BYN»). Пустая — блок не печатается. */
  amountLabel?: string
  warnings: string[]
  advice?: string
  /** Относительный путь созданной сущности — блок «Сделка: Открыть карточку». */
  entityPath: string
  /** Подпись ссылки на сущность («Открыть сделку» / «Открыть счёт»). */
  entityLinkLabel?: string
}

/** Внешний текст в BB-разметке: скобки нейтрализуются, длина капается. */
function safeText(value: string, cap = 300): string {
  return neutralizeBb(String(value)).slice(0, cap)
}

/**
 * Тело дела в BB-разметке: подписанные блоки.
 *
 * ⚠ Ссылка и совет — ТАКИЕ ЖЕ подписанные блоки, как счётчики. До этого совет шёл голой строкой в
 * самом низу, и владелец его на витрине просто не заметил: подпись — это и есть то, что отличает
 * блок от хвоста текста.
 * ⚠ Пустой совет НЕ печатается: заголовок «Что сделать» без указания обещает больше, чем даёт.
 */
export function buildActivityBody(input: ActivityBodyInput): string {
  const supplier = safeText(input.supplierName || 'не указан', 200)
  const hasCompany = !!input.companyId && input.companyId > 0
  const blocks: string[] = [
    `[B]Поставщик:[/B] ${hasCompany ? `[URL=${companyOpenPath(input.companyId!)}]${supplier}[/URL]` : supplier}`,
    `[B]Позиций:[/B] ${input.rowCount}${
      input.matchedCount == null ? '' : ` · сопоставлено с каталогом: ${input.matchedCount}`
    }`
  ]
  if (input.amountLabel) blocks.push(`[B]Сумма:[/B] ${safeText(input.amountLabel, 60)}`)

  if (input.warnings.length) {
    const shown = input.warnings.slice(0, MAX_ACTIVITY_PROBLEMS)
    // ⚠ Счётчик в заголовке — ПОЛНОЕ число проблем, а показано может быть меньше. Печатать
    // длину среза значило бы сообщить, что проблем меньше, чем есть.
    blocks.push('', `[B]Проблемы (${input.warnings.length}):[/B]`, '[LIST]')
    blocks.push(...shown.map(w => `[*]${safeText(w)}`))
    blocks.push('[/LIST]')
    if (input.warnings.length > shown.length) {
      blocks.push(`Показаны первые ${shown.length}; остальные — в сообщении чата.`)
    }
  }

  blocks.push('', `[B]Сделка:[/B] [URL=${safeRelativePath(input.entityPath)}]${
    safeText(input.entityLinkLabel || 'Открыть карточку', 60)
  }[/URL]`)
  if (input.advice) blocks.push('', `[B]Что сделать:[/B] ${safeText(input.advice, 500)}`)
  return blocks.join('\n')
}

/**
 * Поля, дописываемые к делу ОДНИМ вызовом `crm.activity.update` сразу после создания:
 * разметка описания и МАРКЕР приложения.
 *
 * ⚠ Маркер — `ORIGINATOR_ID` («Внешний источник») + `ORIGIN_ID` («Внешний код», у нас id задания).
 * Это штатные поля дела под внешние системы, и главное — **`crm.activity.list` фильтруется по
 * `ORIGINATOR_ID` БЕЗ указания владельца** (live-verified 06.08.2026: `total=1` на портале с
 * чужими делами). Именно это делает исполнимым экран «журнал импортов» — иначе свои дела пришлось
 * бы искать перебором карточек, то есть никак.
 * ⚠ У `crm.activity.todo.add` этих параметров НЕТ — только через `update`. Поэтому вызов один и
 * общий с разметкой: два отдельных стоили бы лишнего обращения к порталу на каждый импорт.
 * ⚠ `ORIGIN_ID` — id задания, тот же, что у маркера созданной сущности. Это даёт делу
 * идемпотентность: повторная доставка задания находит своё дело, а не заводит второе.
 */
export function buildActivityMarkerFields(originatorCode: string, jobId: string): Record<string, unknown> {
  return {
    DESCRIPTION_TYPE: DESCRIPTION_TYPE_BB,
    ORIGINATOR_ID: originatorCode,
    ORIGIN_ID: jobId
  }
}

/** Фильтр для поиска НАШИХ дел (экран журнала + защита от дубля). */
export function activityMarkerFilter(originatorCode: string, jobId?: string): Record<string, string> {
  return { ORIGINATOR_ID: originatorCode, ...(jobId ? { ORIGIN_ID: jobId } : {}) }
}

export interface TodoActivityInput {
  /** Владелец дела — карточка, где оно физически живёт (компания либо созданная сущность). */
  ownerTypeId: number
  ownerId: number
  responsibleId?: number
  title: string
  description: string
  /** Импорт без замечаний: дело закрывается и красится зелёным. */
  clean: boolean
  /** Момент отсчёта срока (мс). Инъектируется, чтобы билдер оставался чистым и тестируемым. */
  nowMs: number
}

/**
 * Параметры `crm.activity.todo.add`. Чистая функция.
 *
 * ⚠ Дело закрывается (`COMPLETED`) ТОЛЬКО у чистого импорта. Прежде оно закрывалось всегда, и
 * документ, у которого не нашлась половина товаров, выглядел в таймлайне ровно как безупречный:
 * закрытое дело читается как «сделано, смотреть незачем». Незакрытое остаётся в списке текущих и
 * попадается на глаза — это единственный сигнал, работающий без чтения.
 */
export function buildTodoActivity(input: TodoActivityInput): Record<string, unknown> {
  const minutes = input.clean ? 0 : ISSUE_DEADLINE_MINUTES
  return {
    ownerTypeId: input.ownerTypeId,
    ownerId: input.ownerId,
    deadline: new Date(input.nowMs + minutes * 60_000).toISOString(),
    title: neutralizeBb(input.title).slice(0, 255),
    description: input.description,
    colorId: input.clean ? TODO_COLOR_CLEAN : TODO_COLOR_ISSUES,
    ...(input.responsibleId ? { responsibleId: input.responsibleId } : {}),
    // Напоминание только у дела с замечаниями — см. ISSUE_PING_OFFSETS.
    ...(input.clean ? {} : { pingOffsets: ISSUE_PING_OFFSETS })
  }
}

/**
 * Сборка входа дела из данных импорта — чистая и экспортированная, чтобы её можно было достать
 * тестом: в проводке (`liveDeps`) она невидима, и подмена признака «чистый импорт» дублирующим
 * ключом проходила бы при всех зелёных проверках (#328).
 */
export function buildActivityInput(input: {
  entityTypeId: number
  entityId: number
  companyId?: number | null
  supplierName?: string
  rowCount: number
  matchedCount?: number | null
  amountLabel?: string
  warnings: string[]
  advice?: string
  nowMs: number
  responsibleId?: number
}): TodoActivityInput {
  const hasCompany = !!input.companyId && input.companyId > 0
  return {
    ownerTypeId: hasCompany ? COMPANY_ENTITY_TYPE_ID : input.entityTypeId,
    ownerId: hasCompany ? input.companyId! : input.entityId,
    title: `Импорт: ${input.supplierName ?? 'документ'}`,
    description: buildActivityBody({
      supplierName: input.supplierName,
      companyId: input.companyId,
      rowCount: input.rowCount,
      matchedCount: input.matchedCount,
      amountLabel: input.amountLabel,
      warnings: input.warnings,
      advice: input.advice,
      entityPath: entityOpenPath(input.entityTypeId, input.entityId),
      entityLinkLabel: entityLinkLabel(input.entityTypeId)
    }),
    // Признак чистоты берётся из ТЕХ ЖЕ warnings, что печатаются в теле: два независимых источника
    // разъехались бы, и дело закрывалось бы при видимом списке проблем.
    clean: input.warnings.length === 0,
    nowMs: input.nowMs,
    ...(input.responsibleId ? { responsibleId: input.responsibleId } : {})
  }
}

/** Вложение исходного документа в дело — ЕДИНСТВЕННАЯ форма, которую портал принимает (#328). */
export function buildFileAttachment(fileName: string, base64: string): Record<string, unknown> {
  return { FILES: [{ fileData: [fileName, base64] }] }
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

/** Подпись ссылки на созданную сущность — «Открыть сделку» и т.п. */
export function entityLinkLabel(entityTypeId: number): string {
  const code = ownerTypeCode(entityTypeId)
  if (code === 'L') return 'Открыть лид'
  if (code === 'D') return 'Открыть сделку'
  if (code === 'Q') return 'Открыть предложение'
  if (code === 'SI') return 'Открыть счёт'
  return 'Открыть карточку'
}

/** Portal path to open a company card. */
export function companyOpenPath(id: number): string {
  return `/crm/company/details/${id}/`
}
