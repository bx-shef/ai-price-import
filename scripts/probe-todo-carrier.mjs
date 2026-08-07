// Приёмка носителя #328 — универсальное дело (`crm.activity.todo.*`) вместо конфигурируемого.
//
// Решение владельца 06.08.2026: To-Do даёт разом три вещи, которые нам нужны, — вложенный файл,
// цвет и состояние «закрыто / не закрыто». Своя иконка при этом теряется (у To-Do она
// захардкожена), и это принятая плата.
//
// Целевое поведение:
//   успех    → дело ЗАКРЫТО,     цвет ЗЕЛЁНЫЙ, файл вложен, дедлайн = текущее время;
//   проблемы → дело НЕ ЗАКРЫТО,  цвет ЖЁЛТЫЙ,  файл вложен, дедлайн = текущее время + 15 минут.
//
// ⚠ Ссылку на исходный файл в дело НЕ кладём (решение владельца 06.08.2026): документ теперь
// вложен в само дело, и ссылка на копию Диска была бы вторым адресом того же документа — человек
// не знает, какой из двух открывать, и они расходятся в правах доступа. Кнопка «Исходный файл»
// из конфигурируемого дела уходит вместе с носителем.
//
// ⚠ Скрипт раскладывает ПАЛИТРУ (`colorId` 1…8 + `default`) отдельными делами: числовые коды
// цветов нигде не документированы в виде «4 = зелёный», а брать их из пересказа чужого кода
// значит записать догадку как факт — ровно то, на чём эта задача уже спотыкалась трижды.
// Владелец смотрит глазами и называет два числа.
//
// ⚠ Проверяется не «вызов прошёл», а РЕЗУЛЬТАТ: каждое дело читается обратно
// (`crm.activity.get`) и сверяется по `COMPLETED`, `FILES` и сроку. `FILES` появляется в ответе
// только когда файл реально прикреплён — это и есть наблюдатель.
//
//   pnpm probe:todo
//   pnpm probe:todo --clean
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { assertTestPortal } from './lib/testPortalGuard.mjs'
import { liveOauth } from './lib/oauthToken.mjs'

const { domain: DOMAIN, token: TOKEN } = await liveOauth()
assertTestPortal(`https://${DOMAIN}/`)

const STATE = 'probe-todo-carrier.json'
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
const info = m => console.log(`  ${m}`)
const head = m => console.log(`\n\x1b[1m${m}\x1b[0m`)

/** Срок в формате, который принимает портал: ISO со смещением. */
const deadlineIn = minutes => new Date(Date.now() + minutes * 60_000).toISOString()

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : null
const save = s => writeFileSync(STATE, JSON.stringify(s, null, 2))

// ── уборка ───────────────────────────────────────────────────────────────────────────────────
if (clean) {
  if (!state) {
    console.log('убирать нечего')
    process.exit(0)
  }
  head('Уборка')
  for (const id of state.activities ?? []) {
    if (!Number.isFinite(id) || id <= 0) continue
    const j = await raw('crm.activity.delete', { id })
    if (j.error) bad(`дело ${id}: ${j.error}`)
    else ok(`дело ${id} удалено`)
  }
  if (state.deal) {
    const j = await raw('crm.deal.delete', { id: state.deal })
    if (j.error) bad(`сделка ${state.deal}: ${j.error}`)
    else ok(`сделка ${state.deal} удалена`)
  }
  rmSync(STATE)
  process.exit(0)
}

// ── прогон ───────────────────────────────────────────────────────────────────────────────────
const stamp = Date.now()
const created = { deal: null, activities: [] }
const FILE_NAME = `накладная № 42 от 06.08.2026 (пример).txt`
const FILE_B64 = Buffer.from('Пример исходного документа для проверки вложения.\n', 'utf8').toString('base64')

/** Завести To-Do и вернуть его id. */
const addTodo = async ({ title, description, colorId, minutes }) => {
  const r = await call('crm.activity.todo.add', {
    ownerTypeId: 2,
    ownerId: created.deal,
    deadline: deadlineIn(minutes),
    title,
    description,
    responsibleId: 1,
    colorId
  })
  const id = Number(r?.id ?? r)
  created.activities.push(id)
  return id
}

/** Вложить файл байтами — единственная работающая по REST форма. */
const attachFile = id => call('crm.activity.update', {
  id,
  fields: { FILES: [{ fileData: [FILE_NAME, FILE_B64] }] }
})

const run = async () => {
  head('Подготовка')
  created.deal = Number(await call('crm.deal.add', { fields: { TITLE: `[PROBE todo] носитель дела ${stamp}` } }))
  save({ deal: created.deal, activities: created.activities })
  ok(`сделка: https://${DOMAIN}/crm/deal/details/${created.deal}/`)

  // --- 1. Палитра: какие числа какого цвета ---------------------------------------------------
  head('1. Палитра colorId — смотреть глазами, коды нигде не описаны словами')
  for (const colorId of ['default', '1', '2', '3', '4', '5', '6', '7', '8']) {
    const id = await addTodo({
      title: `[палитра] colorId = ${colorId}`,
      description: 'Дело заведено только чтобы показать цвет.',
      colorId,
      minutes: 60
    })
    info(`colorId=${colorId} → дело ${id}`)
  }
  save({ deal: created.deal, activities: created.activities })

  // --- 2. Две целевые ветки ровно так, как их описал владелец ---------------------------------
  head('2. Целевое поведение: успех и «есть проблемы»')

  const okId = await addTodo({
    title: `Импорт завершён — накладная № 42`,
    description: 'Позиций: 7. Все строки сопоставлены с каталогом.\nСумма: 10 320,00 BYN.',
    colorId: '4', // предположение «зелёный» — подтверждается палитрой выше
    minutes: 0
  })
  await attachFile(okId)
  await call('crm.activity.update', { id: okId, fields: { COMPLETED: 'Y' } })
  info(`успех → дело ${okId}`)

  const warnId = await addTodo({
    title: `Импорт завершён с замечаниями — накладная № 42`,
    description: 'Позиций: 7, из них не сопоставлено с каталогом: 2.\n\nПроблемы (2):\n'
      + '• Артикул «ZQ-51» в каталоге не найден — строка внесена как произвольная позиция.\n'
      + '• Единица измерения «уп.» неизвестна — записана штука.',
    colorId: '3', // предположение «жёлтый/оранжевый»
    minutes: 15
  })
  await attachFile(warnId)
  info(`проблемы → дело ${warnId}`)

  save({ deal: created.deal, activities: created.activities, okId, warnId })

  // --- 3. Чтение обратно: утверждаем, а не печатаем --------------------------------------------
  head('3. Проверка результата чтением портала')
  const check = async (id, label, { completed, hasFile }) => {
    const a = await call('crm.activity.get', { id })
    const gotCompleted = a.COMPLETED === 'Y'
    const gotFile = Array.isArray(a.FILES) && a.FILES.length > 0
    const problems = []
    if (gotCompleted !== completed) problems.push(`COMPLETED=${a.COMPLETED}, ожидали ${completed ? 'Y' : 'N'}`)
    if (gotFile !== hasFile) problems.push(`файл ${gotFile ? 'есть' : 'ОТСУТСТВУЕТ'}, ожидали ${hasFile ? 'есть' : 'нет'}`)
    if (problems.length) {
      bad(`${label}: ${problems.join('; ')}`)
      process.exitCode = 1
    } else {
      ok(`${label}: закрыто=${a.COMPLETED}, файл=${a.FILES[0]?.id}, срок=${a.DEADLINE}`)
    }
  }
  await check(okId, 'успех', { completed: true, hasFile: true })
  await check(warnId, 'проблемы', { completed: false, hasFile: true })

  head('Смотреть здесь')
  console.log(`  https://${DOMAIN}/crm/deal/details/${created.deal}/`)
  console.log('  Назовите два числа: какой colorId зелёный и какой жёлтый.')
  console.log(`  Убрать: pnpm probe:todo --clean`)
}

try {
  await run()
} catch (e) {
  bad(String(e?.message ?? e))
  save({ deal: created.deal, activities: created.activities })
  process.exitCode = 1
}
