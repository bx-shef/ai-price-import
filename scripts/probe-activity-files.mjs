// Разведка REST-фактов для #328 п.2 — «файл вложением вместо кнопки».
//
// Задача НЕ пишет код. Она отвечает на три вопроса, ответы на которые в справочнике описаны в
// разных местах и противоречиво, а цена ошибки — переезд настраиваемого дела на другой тип записи:
//
//   1. Что ест поле `FILES` у `crm.activity.add`/`update` — ГОЛЫЙ id объекта Диска (как говорит
//      «Как обновить и удалить файлы»: «поле связано с Диском, хранится ID объекта диска») или
//      пару `[имя, base64]` (как показывает пример на странице самого метода)? Два места
//      документации описывают ОДНО поле по-разному.
//   2. Проходит ли `crm.activity.update` с `FILES` по УНИВЕРСАЛЬНОМУ делу (`crm.activity.todo.add`)?
//      У конфигурируемого дела метод отвергается с «Use crm.activity.configurable.update», и
//      предположение «у todo замок не сработает» — это ГИПОТЕЗА, ради проверки которой скрипт и
//      написан.
//   3. Какие типы дел принимает `crm.activity.layout.blocks.set` без `UNSUITABLE_ACTIVITY_TYPE_ERROR`
//      — то есть можно ли навесить наши блоки (счётчики, «Проблемы (N)») на дело чужого типа.
//   4. Работает ли третий вариант — вложение ОТДЕЛЬНЫМ комментарием таймлайна
//      (`crm.timeline.comment.add`), и в какой форме он принимает файл.
//
// ⚠ Скрипт ходит ВЕБХУКОМ, поэтому `crm.activity.configurable.*` здесь недоступен вовсе
// (`ERROR_WRONG_CONTEXT` — метод живёт только в контексте приложения). Это не пробел разведки:
// проверяются ровно те пути, которые РАССМАТРИВАЮТСЯ КАК ЗАМЕНА конфигурируемому делу.
//
// ⚠ Пишет и удаляет на портале: сделку-носитель, дела, файл на Диске. Только тест-портал
// (`assertTestPortal`), уборка в `finally` — иначе на портале останется мусорная сделка.
//
// ═══ ЧТО ПОКАЗАЛ ПРОГОН 06.08.2026 (портал b24-hrbvzq) ═══════════════════════════════════════
//
//   1. `FILES` у дела ЕСТЬ в схеме (`crm.activity.fields` → `diskfile`, множественное, доступно на
//      запись), обе формы принимаются БЕЗ ошибки — и голый id, и `[имя, base64]`. Но проверить
//      результат нечем: `crm.activity.get` и `crm.activity.list` (даже с `select:['*']`, даже с
//      явным `FILES`) поле НЕ ОТДАЮТ — его нет среди 39 возвращаемых ключей. ⚠ Это НЕ значит
//      «не сохранилось»: это значит, что REST не даёт способа отличить сохранённое от
//      выброшенного, и подтвердить вложение можно только глазами в карточке.
//   2. `crm.activity.update` с `FILES` по УНИВЕРСАЛЬНОМУ делу (`CRM_TODO`) отвечает `true` —
//      замка «Use crm.activity.configurable.update» тут действительно нет. Но прочитать результат
//      снова нечем (см. п. 1), поэтому гипотеза из #328 «через todo можно приложить файл»
//      **не подтверждена и не опровергнута**.
//   3. `crm.activity.layout.blocks.set` вебхуком недоступен вовсе — `ERROR_WRONG_CONTEXT`
//      (только контекст приложения). Вопрос «какие типы дел он принимает» этим прогоном
//      НЕ ОТВЕЧЕН и требует OAuth-прогона.
//   4. ✅ Вариант «в» (отдельный комментарий таймлайна) работает и, в отличие от дела,
//      **проверяем**: `crm.timeline.comment.add` с `FILES:[[имя, base64]]` создаёт вложение,
//      `crm.timeline.comment.get` возвращает его с именем, размером и ссылкой на скачивание.
//      ⚠ А вот голый id объекта Диска этот метод принимает БЕЗ ошибки и молча создаёт мусор:
//      файл со случайным именем и размером 2 байта (портал трактует строку id как содержимое).
//      То есть «успех» здесь ничего не доказывает — сверять надо ИМЯ и РАЗМЕР.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   pnpm probe:328
import { uploadFile } from '../server/utils/disk.ts'
import { assertTestPortal } from './lib/testPortalGuard.mjs'
import { readEnvValue } from './lib/envFile.mjs'

const WEBHOOK = readEnvValue('.env.b24test', 'B24_TEST_WEBHOOK')
assertTestPortal(WEBHOOK)

const raw = async (method, params = {}) => {
  const r = await fetch(`${WEBHOOK}${method}.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params)
  })
  return await r.json()
}
/** Бросает на ошибке — для шагов подготовки, где падать надо громко. */
const call = async (method, params = {}) => {
  const j = await raw(method, params)
  if (j.error) throw new Error(`${method}: ${j.error} ${j.error_description || ''}`)
  return j.result
}

const ok = m => console.log(`\x1b[32m✓\x1b[0m ${m}`)
const info = m => console.log(`  ${m}`)
const bad = m => console.log(`\x1b[31m✗\x1b[0m ${m}`)
const head = m => console.log(`\n\x1b[1m${m}\x1b[0m`)

/** Прогнать зонд и НАПЕЧАТАТЬ сырой ответ портала: смысл разведки в фактах, а не в вердикте. */
const probe = async (label, method, params) => {
  const j = await raw(method, params)
  if (j.error) {
    bad(`${label} → ${j.error}: ${j.error_description || ''}`)
    return { ok: false, error: j.error, result: null }
  }
  // Печатаем ВЕСЬ ответ без поля `time`: первая редакция печатала только `result`, и вызов,
  // вернувший ни ошибки, ни результата, читался как «✓ undefined» — то есть как успех.
  const rest = { ...j }
  delete rest.time
  ok(`${label} → ${JSON.stringify(rest).slice(0, 300)}`)
  return { ok: true, error: null, result: j.result }
}

const stamp = Date.now()
const created = { deal: null, activities: [], comments: [], diskFile: null, diskExtra: [] }

const run = async () => {
  // --- Подготовка: файл на Диске + сделка-носитель -------------------------------------------
  head('Подготовка')
  const storages = await call('disk.storage.getlist', {})
  const common = (storages ?? []).find(s => s.ENTITY_TYPE === 'common') ?? storages?.[0]
  if (!common?.ROOT_OBJECT_ID) throw new Error('нет хранилища Диска (нужен скоуп disk)')
  const fileRef = await uploadFile(
    Number(common.ROOT_OBJECT_ID),
    `probe-328-${stamp}.txt`,
    Buffer.from(`probe #328 ${stamp}\n`, 'utf8').toString('base64'),
    call
  )
  created.diskFile = fileRef.id
  ok(`файл на Диске: id=${fileRef.id}`)

  const dealId = await call('crm.deal.add', { fields: { TITLE: `[PROBE 328] ${stamp}` } })
  created.deal = Number(dealId)
  ok(`сделка-носитель: id=${dealId}`)
  const owner = { OWNER_TYPE_ID: 2, OWNER_ID: created.deal }

  // --- Вопрос 1: что ест FILES у crm.activity.add --------------------------------------------
  head('Вопрос 1. Форма поля FILES у crm.activity.add (метод DEPRECATED, проверяем контракт поля)')
  const baseActivity = {
    ...owner,
    TYPE_ID: 4, // прочее
    SUBJECT: `[PROBE 328] files ${stamp}`,
    COMPLETED: 'Y',
    RESPONSIBLE_ID: 1,
    // Без адресата портал молча не создаёт дело: возвращает ни `result`, ни `error`.
    COMMUNICATIONS: [{ TYPE: 'EMAIL', VALUE: 'probe@example.com' }]
  }

  const byId = await probe('FILES = [голый id объекта Диска]', 'crm.activity.add', {
    fields: { ...baseActivity, FILES: [String(fileRef.id)] }
  })
  if (byId.ok) created.activities.push({ id: Number(byId.result), kind: 'add/id' })

  const byPair = await probe('FILES = [[имя, base64]]', 'crm.activity.add', {
    fields: {
      ...baseActivity,
      FILES: [[`probe-pair-${stamp}.txt`, Buffer.from('pair form\n', 'utf8').toString('base64')]]
    }
  })
  if (byPair.ok) created.activities.push({ id: Number(byPair.result), kind: 'add/pair' })

  // Чтение обратно — единственный способ отличить «приняли» от «приняли и выбросили».
  for (const a of created.activities) {
    const got = await raw('crm.activity.get', { id: a.id })
    if (got.error) bad(`чтение ${a.kind} (id=${a.id}) → ${got.error}`)
    else info(`чтение ${a.kind} (id=${a.id}): FILES=${JSON.stringify(got.result?.FILES ?? null)} PROVIDER_ID=${got.result?.PROVIDER_ID ?? '—'}`)
  }

  // --- Вопрос 2: update с FILES по УНИВЕРСАЛЬНОМУ делу ----------------------------------------
  head('Вопрос 2. crm.activity.update c FILES по универсальному делу (crm.activity.todo.add)')
  const deadline = new Date(Date.now() + 24 * 3600 * 1000).toISOString()
  const todo = await probe('crm.activity.todo.add', 'crm.activity.todo.add', {
    ownerTypeId: 2,
    ownerId: created.deal,
    deadline,
    title: `[PROBE 328] todo ${stamp}`,
    description: 'probe',
    responsibleId: 1
  })
  let todoId = null
  if (todo.ok) {
    todoId = Number(todo.result?.id ?? todo.result)
    created.activities.push({ id: todoId, kind: 'todo' })
    await probe('  → crm.activity.update FILES=[id]', 'crm.activity.update', {
      id: todoId,
      fields: { FILES: [String(fileRef.id)] }
    })
    const back = await raw('crm.activity.get', { id: todoId })
    if (back.error) bad(`чтение todo → ${back.error}`)
    else info(`чтение todo (id=${todoId}): FILES=${JSON.stringify(back.result?.FILES ?? null)} PROVIDER_ID=${back.result?.PROVIDER_ID ?? '—'}`)
  }

  // --- Вопрос 3: наши блоки поверх чужого дела ------------------------------------------------
  head('Вопрос 3. crm.activity.layout.blocks.set на универсальном деле')
  if (todoId) {
    await probe('layout.blocks.set (todo)', 'crm.activity.layout.blocks.set', {
      entityTypeId: 2,
      entityId: created.deal,
      activityId: todoId,
      blocks: { probe: { type: 'text', properties: { value: 'проба блока' } } }
    })
  } else {
    bad('todo не создан — вопрос 3 не проверен')
  }

  // --- Вопрос 4: вложение отдельным комментарием таймлайна -------------------------------------
  head('Вопрос 4. crm.timeline.comment.add с вложением (вариант «в» из #328)')
  const byPairCmt = await probe('FILES = [[имя, base64]]', 'crm.timeline.comment.add', {
    fields: {
      ENTITY_ID: created.deal,
      ENTITY_TYPE: 'deal',
      COMMENT: `[PROBE 328] вложение ${stamp}`,
      FILES: [[`probe-doc-${stamp}.txt`, Buffer.from('содержимое документа', 'utf8').toString('base64')]]
    }
  })
  if (byPairCmt.ok) {
    created.comments.push(Number(byPairCmt.result))
    const got = await raw('crm.timeline.comment.get', { id: byPairCmt.result })
    const files = got.result?.FILES ?? null
    info(`чтение комментария: FILES=${JSON.stringify(files)}`)
    // ⚠ Читаем ИМЯ и РАЗМЕР, а не факт непустоты: следующий зонд показывает, что портал
    // отвечает успехом и на заведомо неверную форму, создавая файл-мусор.
    for (const f of Object.values(files ?? {})) created.diskExtra.push(Number(f.id))
  }

  const byIdCmt = await probe('FILES = [голый id объекта Диска]', 'crm.timeline.comment.add', {
    fields: {
      ENTITY_ID: created.deal,
      ENTITY_TYPE: 'deal',
      COMMENT: `[PROBE 328] вложение по id ${stamp}`,
      FILES: [String(fileRef.id)]
    }
  })
  if (byIdCmt.ok) {
    created.comments.push(Number(byIdCmt.result))
    const got = await raw('crm.timeline.comment.get', { id: byIdCmt.result })
    const files = got.result?.FILES ?? null
    info(`чтение комментария: FILES=${JSON.stringify(files)}`)
    for (const f of Object.values(files ?? {})) created.diskExtra.push(Number(f.id))
  }
}

const cleanup = async () => {
  head('Уборка')
  for (const a of created.activities) {
    // ⚠ `NaN` портал принимает и отвечает успехом — первая редакция рапортовала «удалено» о деле,
    // которого не существовало, и настоящий мусор остался бы на портале незамеченным.
    if (!Number.isFinite(a.id) || a.id <= 0) {
      bad(`дело ${a.kind}: нет корректного id (${a.id}) — не удаляем`)
      continue
    }
    const j = await raw('crm.activity.delete', { id: a.id })
    if (j.error) bad(`дело ${a.id} (${a.kind}) не удалено: ${j.error}`)
    else ok(`дело ${a.id} (${a.kind}) удалено`)
  }
  if (created.deal) {
    const j = await raw('crm.deal.delete', { id: created.deal })
    if (j.error) bad(`сделка ${created.deal} не удалена: ${j.error}`)
    else ok(`сделка ${created.deal} удалена`)
  }
  // Файлы, которые портал создал САМ по вложению: без этой уборки каждый прогон оставляет их на Диске.
  for (const id of created.diskExtra) {
    const j = await raw('disk.file.delete', { id })
    if (j.error) bad(`файл-вложение ${id} не удалён: ${j.error}`)
    else ok(`файл-вложение ${id} удалён`)
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
