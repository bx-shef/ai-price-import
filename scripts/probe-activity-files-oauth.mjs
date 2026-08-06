// Вторая часть разведки #328 — то, что вебхуком проверить НЕЛЬЗЯ (OAuth-контекст приложения).
//
// Первый прогон (`pnpm probe:328`, вебхук) уперся в три стены: `crm.activity.configurable.*` и
// `crm.activity.layout.blocks.set` живут только в контексте приложения, а поле `FILES` не
// возвращается ни одним чтением. Здесь ходим OAuth-токеном установленного приложения.
//
// ⚠ И главное — читаем документацию, а не догадываемся. «Как обновить и удалить файлы» говорит
// прямо: «Файл (диск)» — поле связано с Диском, **в поле хранится ID объекта диска**, и оно
// **не обрабатывает base64**. А пример множественного файлового поля показывает форму значения:
// `[{ id: 30577 }, ["новый.pdf", "<base64>"]]` — существующий файл передаётся ОБЪЕКТОМ `{id}`,
// новый — парой. Первый прогон слал голую строку `"265"`, то есть заведомо не ту форму: это была
// проверка догадки, а не контракта.
//
// ═══ ЧТО ПОКАЗАЛ ПРОГОН 06.08.2026 (портал b24-hrbvzq, OAuth установленного приложения) ══════
//
//   1. ✅ **`crm.activity.layout.blocks.set` РАБОТАЕТ на универсальном деле** (`CRM_TODO`) —
//      `{"success":true}`. Первый прогон уперся в `ERROR_WRONG_CONTEXT` (вебхук) и вдобавок слал
//      `blocks` верхним уровнем, а метод ждёт `layout: { blocks: … }`. То есть вариант «б» из #328
//      технически собирается: дело `todo` + НАШИ блоки поверх.
//   2. ✅ Замок конфигурируемого дела подтверждён с двух сторон: `crm.activity.update` по нему →
//      «Use crm.activity.configurable.update», а `layout.blocks.set` по нему →
//      `UNSUITABLE_ACTIVITY_TYPE_ERROR`. Дополнительные блоки предназначены для ЧУЖИХ дел.
//   3. ⚠ Довод «лишнее поле не протащить, есть FIELD_IS_REDUNDANT» ОКАЗАЛСЯ НЕВЕРЕН:
//      `configurable.add` с `FILES` в `fields` прошёл БЕЗ ошибки — поле просто молча игнорируется.
//      Отказ метода тут ничего не сторожит.
//   4. ❌ Прочитать `FILES` по-прежнему нечем — ни `get`, ни `list` с явным `select`, ни под
//      OAuth, ни у одной из ТРЁХ форм записи: `[{id}]` (форма из документации), `["<id>"]`,
//      `WEBDAV_ELEMENTS`. Все три приняты без ошибки. Вывод остаётся прежним и он про НАС:
//      подтвердить вложение можно только глазами в карточке.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   pnpm probe:328:oauth
import { assertTestPortal } from './lib/testPortalGuard.mjs'
import { readEnvValue } from './lib/envFile.mjs'

const DOMAIN = readEnvValue('.env.b24oauth', 'B24_OAUTH_DOMAIN')
const TOKEN = readEnvValue('.env.b24oauth', 'B24_OAUTH_ACCESS_TOKEN')
assertTestPortal(`https://${DOMAIN}/`)

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
const info = m => console.log(`  ${m}`)
const bad = m => console.log(`\x1b[31m✗\x1b[0m ${m}`)
const head = m => console.log(`\n\x1b[1m${m}\x1b[0m`)

const probe = async (label, method, params) => {
  const j = await raw(method, params)
  if (j.error) {
    bad(`${label} → ${j.error}: ${j.error_description || ''}`)
    return { ok: false, result: null }
  }
  const rest = { ...j }
  delete rest.time
  ok(`${label} → ${JSON.stringify(rest).slice(0, 250)}`)
  return { ok: true, result: j.result }
}

/** Прочитать дело ВСЕМИ доступными способами: вопрос «сохранился ли файл» решает чтение. */
const readFiles = async (id, label) => {
  const got = await raw('crm.activity.get', { id })
  const lst = await raw('crm.activity.list', { filter: { ID: id }, select: ['ID', 'FILES', 'WEBDAV_ELEMENTS', 'PROVIDER_ID'] })
  info(`${label}: get.FILES=${JSON.stringify(got.result?.FILES)} list=${JSON.stringify(lst.result?.[0])}`)
}

const stamp = Date.now()
const created = { deal: null, activities: [], diskFile: null }

const run = async () => {
  head('Подготовка')
  const storages = await call('disk.storage.getlist', {})
  const common = (storages ?? []).find(s => s.ENTITY_TYPE === 'common') ?? storages?.[0]
  const up = await call('disk.folder.uploadfile', {
    id: common.ROOT_OBJECT_ID,
    data: { NAME: `probe-oauth-${stamp}.txt` },
    fileContent: [`probe-oauth-${stamp}.txt`, Buffer.from('содержимое документа', 'utf8').toString('base64')]
  })
  created.diskFile = Number(up.ID)
  ok(`файл на Диске: id=${created.diskFile}`)
  created.deal = Number(await call('crm.deal.add', { fields: { TITLE: `[PROBE 328 oauth] ${stamp}` } }))
  ok(`сделка-носитель: id=${created.deal}`)

  // --- 1. Форма значения diskfile ПО ДОКУМЕНТАЦИИ: объект {id}, а не голая строка -------------
  head('1. FILES у обычного дела: форма {id} против голой строки (док «Как обновить и удалить файлы»)')
  const base = {
    OWNER_TYPE_ID: 2,
    OWNER_ID: created.deal,
    TYPE_ID: 4,
    SUBJECT: `[PROBE] files ${stamp}`,
    COMPLETED: 'Y',
    RESPONSIBLE_ID: 1,
    COMMUNICATIONS: [{ TYPE: 'EMAIL', VALUE: 'probe@example.com' }]
  }
  for (const [label, FILES] of [
    ['FILES=[{id}] (форма из документации)', [{ id: created.diskFile }]],
    ['FILES=["<id>"] (форма первого прогона)', [String(created.diskFile)]],
    ['WEBDAV_ELEMENTS=[{id}] (устаревшее поле)', null]
  ]) {
    const fields = FILES ? { ...base, FILES } : { ...base, WEBDAV_ELEMENTS: [{ id: created.diskFile }] }
    const r = await probe(label, 'crm.activity.add', { fields })
    if (r.ok && Number(r.result) > 0) {
      created.activities.push(Number(r.result))
      await readFiles(Number(r.result), `  чтение (${label})`)
    }
  }

  // --- 2. Универсальное дело + update ---------------------------------------------------------
  head('2. Универсальное дело (crm.activity.todo.add) + update с FILES')
  const todo = await probe('todo.add', 'crm.activity.todo.add', {
    ownerTypeId: 2,
    ownerId: created.deal,
    deadline: new Date(Date.now() + 864e5).toISOString(),
    title: `[PROBE] todo ${stamp}`,
    responsibleId: 1
  })
  const todoId = todo.ok ? Number(todo.result?.id ?? todo.result) : null
  if (todoId) {
    created.activities.push(todoId)
    await probe('  update FILES=[{id}]', 'crm.activity.update', { id: todoId, fields: { FILES: [{ id: created.diskFile }] } })
    await readFiles(todoId, '  чтение todo')
  }

  // --- 3. Наши блоки поверх ЧУЖОГО дела (только контекст приложения) ---------------------------
  head('3. crm.activity.layout.blocks.set — параметр `layout`, а не `blocks` (первый прогон слал не то)')
  if (todoId) {
    await probe('layout.blocks.set на универсальном деле', 'crm.activity.layout.blocks.set', {
      entityTypeId: 2,
      entityId: created.deal,
      activityId: todoId,
      layout: { blocks: { probe: { type: 'text', properties: { value: `проба блока ${stamp}` } } } }
    })
  }

  // --- 4. Есть ли у конфигурируемого дела шанс принять файл ------------------------------------
  head('4. Конфигурируемое дело: принимает ли FILES (ожидаем FIELD_IS_REDUNDANT — список полей закрыт)')
  const conf = await probe('configurable.add с FILES в fields', 'crm.activity.configurable.add', {
    ownerTypeId: 2,
    ownerId: created.deal,
    fields: { typeId: 'CONFIGURABLE', completed: 'Y', responsibleId: 1, FILES: [{ id: created.diskFile }] },
    layout: {
      icon: { code: 'sum' },
      header: { title: `[PROBE] configurable ${stamp}` },
      body: { logo: { code: 'document' }, blocks: { t: { type: 'text', properties: { value: 'проба' } } } }
    }
  })
  if (conf.ok && conf.result?.activity?.id) created.activities.push(Number(conf.result.activity.id))

  const conf2 = await probe('configurable.add без FILES (контрольный)', 'crm.activity.configurable.add', {
    ownerTypeId: 2,
    ownerId: created.deal,
    fields: { typeId: 'CONFIGURABLE', completed: 'Y', responsibleId: 1 },
    layout: {
      icon: { code: 'sum' },
      header: { title: `[PROBE] configurable ok ${stamp}` },
      body: { logo: { code: 'document' }, blocks: { t: { type: 'text', properties: { value: 'проба' } } } }
    }
  })
  const confId = conf2.ok ? Number(conf2.result?.activity?.id) : null
  if (confId) {
    created.activities.push(confId)
    // ⚠ Ключевой вопрос: можно ли ДОПИСАТЬ файл к уже созданному конфигурируемому делу.
    await probe('  → crm.activity.update FILES по конфигурируемому делу', 'crm.activity.update', {
      id: confId, fields: { FILES: [{ id: created.diskFile }] }
    })
    await probe('  → layout.blocks.set по конфигурируемому делу', 'crm.activity.layout.blocks.set', {
      entityTypeId: 2,
      entityId: created.deal,
      activityId: confId,
      layout: { blocks: { extra: { type: 'text', properties: { value: 'доп. блок' } } } }
    })
    await readFiles(confId, '  чтение конфигурируемого')
  }
}

const cleanup = async () => {
  head('Уборка')
  for (const id of created.activities) {
    if (!Number.isFinite(id) || id <= 0) continue
    const j = await raw('crm.activity.delete', { id })
    if (j.error) bad(`дело ${id} не удалено: ${j.error}`)
    else ok(`дело ${id} удалено`)
  }
  if (created.deal) {
    const j = await raw('crm.deal.delete', { id: created.deal })
    if (j.error) bad(`сделка ${created.deal} не удалена: ${j.error}`)
    else ok(`сделка ${created.deal} удалена`)
  }
  if (created.diskFile) {
    const j = await raw('disk.file.delete', { id: created.diskFile })
    if (j.error) bad(`файл ${created.diskFile} не удалён: ${j.error}`)
    else ok(`файл ${created.diskFile} удалён`)
  }
}

try {
  await run()
} catch (e) {
  bad(String(e?.message ?? e))
  process.exitCode = 1
} finally {
  await cleanup()
}
