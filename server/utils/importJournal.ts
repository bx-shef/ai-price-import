import { activityMarkerFilter } from './todoActivity'

// Журнал импортов — список дел, которые приложение записало в таймлайн CRM (#458).
//
// ЗАЧЕМ. Истории импортов у нас не было НИГДЕ: серверного списка заданий нет намеренно, клиентский
// умер вместе с localStorage, а статус задания живёт 6 часов в Redis и адресуется только по id.
// Закрыл вкладку — потерял всё, включая единственный след неудачного разбора. Дело в портале
// закрывает это без единой строки нашего хранилища: журнал живёт у клиента, под его правами и его
// сроками, а наш срок хранения к нему не применяется вовсе.
//
// ПОЧЕМУ ЭТО ВООБЩЕ ИСПОЛНИМО. `crm.activity.list` фильтруется по `ORIGINATOR_ID` **без указания
// владельца** — проверено живьём 06.08.2026 на портале с чужими делами. Не будь этого, свои дела
// пришлось бы искать перебором карточек, то есть никак.
//
// ⚠ ТОЛЬКО СВОИ ДЕЛА (решение владельца 08.08.2026): выборка всегда сужена по `RESPONSIBLE_ID` до
// сотрудника из ПРОВЕРЕННОГО фрейм-токена. Журнал показывает имена загруженных файлов и
// поставщиков — на портале, где отдел кадров и склад работают в одной CRM, общий список выдал бы
// одним сотрудникам содержимое работы других. Ответственный у дела — тот, кто загрузил документ.

/** Сколько дел на СТРАНИЦЕ. Решение владельца 10.08.2026 — по 50 и постраничная навигация вместо
 *  бесконечной прокрутки: она предсказуема, работает с клавиатуры и не требует своего контейнера
 *  прокрутки, который во фрейме портала мешал. ⚠ Портал отдаёт страницами по 50, так что это ещё и
 *  ровно один запрос на страницу. */
export const JOURNAL_PAGE_SIZE = 50

/** Поля дела, которых хватает списку. Просим ЯВНО: `select:['*']` тянет и описание с телом
 *  документа, а оно в журнале не нужно и раздувает ответ на каждую строку. */
/**
 * ⚠ `DESCRIPTION`, `FILES` и `SETTINGS` добавлены по ЖИВОЙ ПРОВЕРКЕ 10.08.2026 (портал b24-hrbvzq):
 * `crm.activity.list` отдаёт их при ЯВНОМ `select` — описание целиком, вложение парой `id`+`url`,
 * цвет в `SETTINGS.COLOR`. Это переворачивает прежнюю запись в `probe-activity-files`, где значилось
 * «list не отдаёт FILES даже с `select:['*']`»: разница именно в явном перечислении полей, а не в
 * контексте вызова. Отдельного поля `COLOR` не существует — только внутри `SETTINGS`.
 * ⚠ Следствие: батч по строкам НЕ НУЖЕН — страница журнала это по-прежнему ОДИН запрос к порталу.
 * ⚠ `select:['*']` не берём: он тянет ещё три десятка полей, включая служебные, а описание у нас и
 * так самое тяжёлое поле строки.
 */
export const JOURNAL_SELECT = [
  'ID', 'SUBJECT', 'COMPLETED', 'CREATED', 'ORIGIN_ID', 'OWNER_TYPE_ID', 'OWNER_ID',
  'DESCRIPTION', 'FILES', 'SETTINGS'
] as const

/** Параметры вызова портала. Индексная сигнатура — чтобы тип подходил транспорту `RestCall`,
 *  который принимает свободный набор параметров. */
export interface JournalQuery extends Record<string, unknown> {
  filter: Record<string, string>
  select: string[]
  order: Record<string, string>
  start: number
}

/**
 * Параметры `crm.activity.list` для журнала сотрудника.
 *
 * ⚠ `RESPONSIBLE_ID` ставится ВСЕГДА и **fail-closed**: неизвестный id даёт `'0'`, то есть пустую
 * выборку, а не выборку по всему порталу. Ошибка в эту сторону показала бы человеку чужие
 * документы, и заметить это по внешнему виду экрана невозможно — список выглядел бы просто
 * длиннее.
 * ⚠ Сортировка по `ID`, а не по `CREATED`: id монотонен, а метка времени у дел, созданных в одну
 * секунду (пачка документов — обычное дело), не задаёт порядка вовсе.
 */
export function buildJournalQuery(originatorCode: string, responsibleId: unknown, start = 0): JournalQuery {
  const uid = Number(responsibleId)
  const safeUid = Number.isInteger(uid) && uid > 0 ? String(uid) : '0'
  return {
    filter: { ...activityMarkerFilter(originatorCode), RESPONSIBLE_ID: safeUid },
    select: [...JOURNAL_SELECT],
    order: { ID: 'DESC' },
    start: Number.isInteger(start) && start > 0 ? start : 0
  }
}

/** Строка журнала, как её видит браузер. */
export interface JournalRow {
  /** Id дела — ключ строки и адрес, по которому её открывают. */
  activityId: number
  /** Id задания импорта: связывает строку с отзывом и с повтором. */
  jobId: string
  title: string
  /** Импорт прошёл без замечаний (дело закрыто). */
  clean: boolean
  createdAt: string
  /**
   * ВЛАДЕЛЕЦ дела — карточка, в которой оно физически лежит.
   *
   * ⚠ Это НЕ всегда созданная импортом сущность. По модели владельца (`todoActivity`) при
   * найденном контрагенте владельцем становится КОМПАНИЯ (тип 4), а сделка привязывается вторым
   * шагом. Поля названы честно (`ownerTypeId`/`ownerId`), потому что прежнее имя
   * `entityTypeId` читалось как «сделка» и строило бы ссылку на несуществующий путь
   * `/crm/type/4/details/…` у каждого успешного импорта с распознанным поставщиком.
   */
  ownerTypeId: number
  ownerId: number
  /** Тело дела как есть — разбирается на клиенте (`parseActivityBody`). */
  description: string
  /** Адрес вложенного документа в портале; пусто — файла у дела нет. */
  fileUrl: string
  /** Цвет САМОГО дела (`SETTINGS.COLOR`) — по нему журнал и красит исход. */
  colorId: string
}

/** Строка `crm.activity.list`, из которой мы читаем. Поля портала приходят строками. */
interface RawActivity {
  ID?: unknown
  SUBJECT?: unknown
  COMPLETED?: unknown
  CREATED?: unknown
  ORIGIN_ID?: unknown
  OWNER_TYPE_ID?: unknown
  OWNER_ID?: unknown
  DESCRIPTION?: unknown
  FILES?: unknown
  SETTINGS?: unknown
}

/**
 * Адрес вложения из `FILES`.
 *
 * ⚠ Берём ПЕРВЫЙ файл: дело импорта несёт ровно один документ, а гадать, какой из нескольких
 * «исходный», значило бы однажды дать ссылку не на тот. ⚠ Адрес обязан быть портальным `https://`:
 * дело могли править руками, и чужой адрес ушёл бы человеку под нашей подписью «исходный файл».
 */
function fileUrlOf(files: unknown): string {
  if (!Array.isArray(files) || !files.length) return ''
  const url = (files[0] as { url?: unknown })?.url
  return typeof url === 'string' && url.startsWith('https://') ? url : ''
}

/** Цвет дела лежит ВНУТРИ `SETTINGS` — отдельного поля `COLOR` у дела нет (живая проверка). */
function colorOf(settings: unknown): string {
  const c = (settings as { COLOR?: unknown } | null)?.COLOR
  return typeof c === 'string' ? c.trim().slice(0, 8) : ''
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * Ответ портала → строки журнала. Чистая, поэтому тестируется без портала.
 *
 * ⚠ Строки БЕЗ `ORIGIN_ID` отбрасываются. Такое дело не наше: связать его с заданием нечем, а
 * значит ни отзыв, ни повтор по нему не работают — строка выглядела бы рабочей и не была бы ею.
 * ⚠ `COMPLETED` у портала — `'Y'`/`'N'` строкой. Сравнение с булевым `true` молча давало бы
 * «замечания есть» у каждого чистого импорта, и журнал был бы сплошь тревожным.
 */
export function mapJournalRows(rows: unknown): JournalRow[] {
  if (!Array.isArray(rows)) return []
  const out: JournalRow[] = []
  for (const raw of rows as RawActivity[]) {
    const jobId = typeof raw?.ORIGIN_ID === 'string' ? raw.ORIGIN_ID.trim() : ''
    const activityId = num(raw?.ID)
    if (!jobId || activityId <= 0) continue
    out.push({
      activityId,
      jobId,
      // Заголовок дела приходит из документа (имя поставщика), но в браузер уходит через `{{ }}`,
      // а BB-скобки нейтрализованы ещё при записи — здесь достаточно обрезки.
      title: String(raw?.SUBJECT ?? '').slice(0, 255),
      clean: raw?.COMPLETED === 'Y',
      createdAt: String(raw?.CREATED ?? ''),
      ownerTypeId: num(raw?.OWNER_TYPE_ID),
      ownerId: num(raw?.OWNER_ID),
      // Тело уходит в браузер как есть и печатается через `{{ }}`: разметка нейтрализована ещё при
      // записи, а разбор — чистая функция на клиенте, ей нужен исходный текст.
      description: typeof raw?.DESCRIPTION === 'string' ? raw.DESCRIPTION.slice(0, 4000) : '',
      fileUrl: fileUrlOf(raw?.FILES),
      colorId: colorOf(raw?.SETTINGS)
    })
  }
  return out
}
