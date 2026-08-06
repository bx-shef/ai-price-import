// Витрина для решения по #328: создаёт на тест-портале ОДНУ сделку и кладёт в её таймлайн
// ТРИ варианта подачи документа рядом, чтобы владелец сравнил их глазами. НИЧЕГО НЕ УБИРАЕТ.
//
//   а) как сейчас — конфигурируемое дело: наш вид, подвал с кнопками, файл ССЫЛКОЙ;
//   б) вариант «б» — универсальное дело + `crm.activity.layout.blocks.set` (наши блоки).
//      ⚠ Прикрепление файла кладётся ШЕСТЬЮ формами сразу, по делу на форму, с формой в
//      заголовке: `[{id}]`, `[[имя,base64]]`, `["n<id>"]`, `[<id>]`, и то же через
//      `WEBDAV_ELEMENTS`. Прочитать результат по REST нельзя (поле не возвращается ни одним
//      чтением), портал принимает любую форму без ошибки — значит единственный наблюдатель
//      человек, и формы надо положить рядом и подписать. Подвала с кнопками у этого типа НЕТ,
//      поэтому «Открыть» становится блоком-ссылкой;
//   в) вариант «в» — конфигурируемое дело + ОТДЕЛЬНЫЙ комментарий таймлайна с настоящим вложением.
//
// ⚠ Уборки нет намеренно (решение владельца 06.08.2026): смысл в том, чтобы посмотреть. Убрать —
// `pnpm probe:328:show --clean` (читает `probe-328-showcase.json`, который пишется рядом).
//
// ⚠ Только тест-портал (`assertTestPortal`), OAuth-контекст приложения — конфигурируемое дело и
// доп. блоки вебхуком недоступны.
//
// ═══ ОТВЕТ ПОЛУЧЕН (владелец посмотрел карточку 06.08.2026) ══════════════════════════════════
//
// ✅ Файл прикрепляется — форма ровно одна: **`FILES: [{ fileData: [имя, base64] }]`**, та, что
//    показана в примере на странице метода `crm.activity.add`. Шесть форм из статьи про файловые
//    поля (`[{id}]`, `["n<id>"]`, `[<id>]`, `WEBDAV_ELEMENTS`) не дали НИЧЕГО — и, что важнее,
//    ни одна из них не вернула ошибки. Портал отвечал `true` на все семь.
//
// ⚠ ЦЕНА, которую видно только на Диске: `fileData` — это base64, то есть портал заводит СВОЮ
//    КОПИЮ файла. Проверено чтением: у нашей архивной копии id=299 (общий Диск), а у вложений —
//    303 и 305 в служебной папке CRM плюс 307 в хранилище пользователя от комментария. Один
//    документ клиента = несколько копий на портале, и живут они по разным правилам.
//    ⇒ Передать УЖЕ лежащий на Диске файл по id невозможно: байты придётся докачивать
//    (`server/utils/diskDownload.ts`) и слать заново.
//
// ⚠ И второе, что видно на карточке: у `todo` своя обвязка — «Сделать до завтра», кнопка
//    «Выполнено», «Изменить файлы». Это НЕ отчёт об импорте, это поручение сотруднику; подвала
//    с кнопками нет, «Открыть сделку» стало блоком-ссылкой.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   pnpm probe:328:show
//   pnpm probe:328:show --clean
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { assertTestPortal } from './lib/testPortalGuard.mjs'
import { liveOauth } from './lib/oauthToken.mjs'

// ⚠ Токен берём через `liveOauth`, а не из файла напрямую: access живёт час, и прогон падал
// `expired_token` на середине, успев наплодить записей на портале.
const { domain: DOMAIN, token: TOKEN } = await liveOauth()
assertTestPortal(`https://${DOMAIN}/`)

const STATE = 'probe-328-showcase.json'
const clean = process.argv.slice(2).includes('--clean')

const raw = async (method, params = {}) => {
  const r = await fetch(`https://${DOMAIN}/rest/${method}.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...params, auth: TOKEN })
  })
  return await r.json()
}
const call = async (method, params = {}) => {
  const j = await raw(method, params)
  if (j.error) throw new Error(`${method}: ${j.error} ${j.error_description || ''}`)
  return j.result
}

const ok = m => console.log(`\x1b[32m✓\x1b[0m ${m}`)
const bad = m => console.log(`\x1b[31m✗\x1b[0m ${m}`)
const head = m => console.log(`\n\x1b[1m${m}\x1b[0m`)

// Правдоподобные данные одного импорта — чтобы сравнивать вид, а не «Lorem ipsum».
const SUPPLIER = 'ООО «Белпромснаб»'
const DOC = 'ТН-000451 от 05.08.2026'
const TOTAL = '10 320,00 BYN'
const LINES = 7
const MATCHED = 5
const PROBLEM = 'Не найдены в каталоге: 2 позиции (ZQ-114, ZQ-207)'

const doClean = async () => {
  if (!existsSync(STATE)) return bad(`нет ${STATE} — убирать нечего`)
  const s = JSON.parse(readFileSync(STATE, 'utf8'))
  head('Уборка витрины')
  for (const id of s.activities ?? []) {
    const j = await raw('crm.activity.delete', { id })
    if (j.error) bad(`дело ${id}: ${j.error}`)
    else ok(`дело ${id} удалено`)
  }
  if (s.deal) {
    const j = await raw('crm.deal.delete', { id: s.deal })
    if (j.error) bad(`сделка ${s.deal}: ${j.error}`)
    else ok(`сделка ${s.deal} удалена`)
  }
  for (const id of s.diskFiles ?? []) {
    const j = await raw('disk.file.delete', { id })
    if (j.error) bad(`файл ${id}: ${j.error}`)
    else ok(`файл ${id} удалён`)
  }
  rmSync(STATE)
}

const build = async () => {
  const state = { deal: null, activities: [], diskFiles: [] }
  head('Витрина #328 — три варианта в одной сделке')

  // Файл-«исходник» на Диске: ровно так его кладёт импорт.
  const storages = await call('disk.storage.getlist', {})
  const common = (storages ?? []).find(s => s.ENTITY_TYPE === 'common') ?? storages?.[0]
  const bytes = Buffer.from(
    `${DOC}\nПоставщик: ${SUPPLIER}\nПозиций: ${LINES}\nВсего к оплате: ${TOTAL}\n`, 'utf8'
  ).toString('base64')
  // ⚠ Имя уникально на прогон: Диск отвергает повтор (`DISK_OBJ_22000`), и вторая витрина
  // падала бы на первом же шаге — а прошлая при этом уже висит на портале.
  const fileName = `Накладная ТН-000451__demo-${Date.now()}.txt`
  const up = await call('disk.folder.uploadfile', {
    id: common.ROOT_OBJECT_ID,
    data: { NAME: fileName },
    fileContent: [fileName, bytes]
  })
  const diskId = Number(up.ID)
  state.diskFiles.push(diskId)
  ok(`файл на Диске: id=${diskId}`)

  const deal = Number(await call('crm.deal.add', {
    fields: { TITLE: `[ВИТРИНА #328] ${SUPPLIER} · ${DOC}`, OPPORTUNITY: 10320, CURRENCY_ID: 'BYN' }
  }))
  state.deal = deal
  ok(`сделка: id=${deal}`)

  const counters = {
    supplier: { type: 'withTitle', properties: { title: 'Поставщик', block: { type: 'text', properties: { value: SUPPLIER } } } },
    doc: { type: 'withTitle', properties: { title: 'Документ', block: { type: 'text', properties: { value: DOC } } } },
    sum: { type: 'withTitle', properties: { title: 'Сумма', block: { type: 'text', properties: { value: TOTAL, bold: true } } } },
    lines: { type: 'withTitle', properties: { title: 'Позиции', block: { type: 'text', properties: { value: `${LINES} строк, подобрано ${MATCHED}` } } } },
    problems: { type: 'withTitle', properties: { title: 'Проблемы (1)', block: { type: 'text', properties: { value: PROBLEM, multiline: true } } } }
  }
  const fileUrl = `/docs/file/${encodeURIComponent(fileName)}?IFRAME=Y&IFRAME_TYPE=SIDE_SLIDER`

  // --- (а) как сейчас: конфигурируемое дело с подвалом-кнопками ------------------------------
  const a = await call('crm.activity.configurable.add', {
    ownerTypeId: 2,
    ownerId: deal,
    fields: { typeId: 'CONFIGURABLE', completed: 'Y', responsibleId: 1 },
    layout: {
      icon: { code: 'sum' },
      header: { title: `(а) КАК СЕЙЧАС · Импорт документа · ${TOTAL}` },
      body: { logo: { code: 'document' }, blocks: counters },
      footer: {
        buttons: {
          open: { title: 'Открыть', type: 'primary', action: { type: 'redirect', uri: `/crm/deal/details/${deal}/` } },
          source: { title: 'Исходный файл', type: 'secondary', action: { type: 'redirect', uri: fileUrl } }
        }
      }
    }
  })
  state.activities.push(Number(a.activity.id))
  ok(`(а) конфигурируемое дело: id=${a.activity.id} — файл ССЫЛКОЙ в подвале`)

  // --- (б) универсальное дело + наши блоки + ПЕРЕБОР ФОРМ ПРИКРЕПЛЕНИЯ -----------------------
  //
  // ⚠ Почему перебор, а не одна «правильная» форма: прочитать `FILES` обратно НЕЛЬЗЯ — ни `get`,
  // ни `list` с явным `select` его не отдают (проверено под OAuth). Портал принимает ЛЮБУЮ форму
  // без ошибки, поэтому «вызов прошёл» ничего не доказывает. Единственный доступный наблюдатель —
  // человек, открывший карточку. Значит, кладём все формы РЯДОМ и подписываем каждую в заголовке.
  const forms = [
    ['FILES = [{ id }]', { FILES: [{ id: diskId }] }],
    ['FILES = [[имя, base64]]', { FILES: [[fileName, bytes]] }],
    ['FILES = ["n<id>"]', { FILES: [`n${diskId}`] }],
    ['FILES = [<id> числом]', { FILES: [diskId] }],
    ['WEBDAV_ELEMENTS = [{ id }]', { WEBDAV_ELEMENTS: [{ id: diskId }] }],
    ['WEBDAV_ELEMENTS = ["n<id>"]', { WEBDAV_ELEMENTS: [`n${diskId}`] }],
    // ⚠ Седьмая форма — из примера на странице САМОГО метода `crm.activity.add`:
    // `FILES:[{"fileData":["example.jpg","base64…"]}]`. Первые шесть перебирали формы из статьи
    // про файловые поля, а страница метода показывает свою — и именно её я до сих пор не пробовал.
    ['FILES = [{ fileData: [имя, base64] }]', { FILES: [{ fileData: [fileName, bytes] }] }]
  ]
  for (const [label, fields] of forms) {
    const todo = await call('crm.activity.todo.add', {
      ownerTypeId: 2,
      ownerId: deal,
      deadline: new Date(Date.now() + 864e5).toISOString(),
      title: `(б) ${label}`,
      description: `${SUPPLIER} · ${DOC} · файл на Диске id=${diskId}`,
      responsibleId: 1
    })
    const todoId = Number(todo.id)
    state.activities.push(todoId)
    const upd = await raw('crm.activity.update', { id: todoId, fields })
    const blocks = await raw('crm.activity.layout.blocks.set', {
      entityTypeId: 2,
      entityId: deal,
      activityId: todoId,
      layout: {
        blocks: {
          ...counters,
          // Подвала с кнопками у этого типа НЕТ — «Открыть» становится блоком-ссылкой.
          open: { type: 'link', properties: { text: 'Открыть сделку', bold: true, action: { type: 'redirect', uri: `/crm/deal/details/${deal}/` } } }
        }
      }
    })
    ok(`(б) ${label} → дело ${todoId} · update=${JSON.stringify(upd.result ?? upd.error)} · блоки=${JSON.stringify(blocks.result ?? blocks.error)}`)
  }

  // --- (г) СИСТЕМНОЕ дело `crm.activity.add` — метод, в примере которого и показан `fileData` ---
  //
  // ⚠ Метод DEPRECATED и в продукт не пойдёт. Он здесь ровно затем, чтобы отделить два вопроса:
  // «форма значения неверна» и «у дела этого ТИПА вложение не рисуется вовсе». Если скрепка
  // появится тут и не появится у `todo` — дело в типе, и вариант «б» отпадает по построению.
  for (const [label, FILES] of [
    ['fileData', [{ fileData: [fileName, bytes] }]],
    ['{ id }', [{ id: diskId }]]
  ]) {
    const sys = await raw('crm.activity.add', {
      fields: {
        OWNER_TYPE_ID: 2,
        OWNER_ID: deal,
        TYPE_ID: 4,
        SUBJECT: `(г) СИСТЕМНОЕ дело · FILES = ${label}`,
        DESCRIPTION: `${SUPPLIER} · ${DOC}`,
        COMPLETED: 'Y',
        RESPONSIBLE_ID: 1,
        COMMUNICATIONS: [{ TYPE: 'EMAIL', VALUE: 'probe@example.com' }],
        FILES
      }
    })
    if (sys.result) {
      state.activities.push(Number(sys.result))
      ok(`(г) системное дело FILES=${label} → id=${sys.result}`)
    } else {
      bad(`(г) системное дело FILES=${label} → ${sys.error}: ${sys.error_description || ''}`)
    }
  }

  // --- (в) конфигурируемое дело + отдельный комментарий с ВЛОЖЕНИЕМ ---------------------------
  const c = await call('crm.activity.configurable.add', {
    ownerTypeId: 2,
    ownerId: deal,
    fields: { typeId: 'CONFIGURABLE', completed: 'Y', responsibleId: 1 },
    layout: {
      icon: { code: 'sum' },
      header: { title: `(в) ВАРИАНТ В · Импорт документа · ${TOTAL}` },
      body: { logo: { code: 'document' }, blocks: counters },
      footer: { buttons: { open: { title: 'Открыть', type: 'primary', action: { type: 'redirect', uri: `/crm/deal/details/${deal}/` } } } }
    }
  })
  state.activities.push(Number(c.activity.id))
  const cmt = await call('crm.timeline.comment.add', {
    fields: {
      ENTITY_ID: deal,
      ENTITY_TYPE: 'deal',
      COMMENT: `(в) Исходный документ импорта: ${DOC}`,
      // ⚠ Только пара [имя, base64]: голый id объекта Диска портал принимает БЕЗ ошибки и молча
      // создаёт файл-мусор со случайным именем размером 2 байта (живая проверка 06.08.2026).
      FILES: [[fileName, bytes]]
    }
  })
  ok(`(в) конфигурируемое дело id=${c.activity.id} + комментарий id=${cmt} с настоящим вложением`)

  writeFileSync(STATE, JSON.stringify(state, null, 2))
  head('Смотреть здесь')
  console.log(`  https://${DOMAIN}/crm/deal/details/${deal}/`)
  console.log(`\n  Убрать потом: pnpm probe:328:show --clean`)
}

try {
  if (clean) await doClean()
  else await build()
} catch (e) {
  bad(String(e?.message ?? e))
  process.exitCode = 1
}
