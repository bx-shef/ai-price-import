// Приёмка носителя #328 — универсальное дело (`crm.activity.todo.*`) вместо конфигурируемого.
//
// Решение владельца 06.08.2026: To-Do даёт разом три вещи, которые нам нужны, — вложенный файл,
// цвет и состояние «закрыто / не закрыто». Своя иконка при этом теряется (у To-Do она
// захардкожена), и это принятая плата.
//
// Целевое поведение:
//   успех    → дело ЗАКРЫТО,     цвет ЗЕЛЁНЫЙ, файл вложен, дедлайн = текущее время;
//   проблемы → дело НЕ ЗАКРЫТО,  цвет РОЗОВЫЙ, файл вложен, дедлайн = текущее время + 15 минут.
//
// ⚠ Палитра `colorId` (снята из `colorsettingsprovider.php`, значения — СТРОКИ):
//   `default` #FFC34D жёлтый · `1` #4090C7 синий · `2` #29D9D0 бирюзовый · `3` #F57E02 оранжевый
//   `4` #8FB035 ЗЕЛЁНЫЙ · `5` #B37DC4 фиолетовый · `6` #858F9E серый · `7` #DA7790 РОЗОВЫЙ
// Проверить оттенок программно нечем в принципе: REST отдаёт сохранённый `colorId`, но не цвет,
// — поэтому числа берём из перечисления, а прогон раскладывает палитру для сверки глазами.
// ⚠ Жёлтый — это `default`, у него НЕТ цифрового номера: не передав `colorId` вовсе, получим
// жёлтое дело. То есть «цвет не задан» и «цвет жёлтый» на портале одно и то же, и молчаливый
// пропуск параметра выглядел бы как осознанный выбор.
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
  // ⚠ Компанию убираем ТОЖЕ: её заводит витрина ради ссылки на поставщика, и забытая карточка
  // «ООО „Ромашка“ (проба)» осталась бы в CRM тест-портала неотличимой от настоящей.
  if (state.company) {
    const j = await raw('crm.company.delete', { id: state.company })
    if (j.error) bad(`компания ${state.company}: ${j.error}`)
    else ok(`компания ${state.company} удалена`)
  }
  rmSync(STATE)
  process.exit(0)
}

// ── прогон ───────────────────────────────────────────────────────────────────────────────────
const stamp = Date.now()
const created = { deal: null, activities: [] }
/** Успех — зелёный (#8FB035), замечания — розовый (#DA7790). Решение владельца 06.08.2026. */
const GREEN = '4'
const PINK = '7'

const FILE_NAME = `накладная № 42 от 06.08.2026 (пример).txt`
const FILE_B64 = Buffer.from('Пример исходного документа для проверки вложения.\n', 'utf8').toString('base64')

/** Завести To-Do и вернуть его id. */
const addTodo = async ({ title, description, colorId, minutes, bb, ping }) => {
  const r = await call('crm.activity.todo.add', {
    ownerTypeId: 2,
    ownerId: created.deal,
    deadline: deadlineIn(minutes),
    title,
    description,
    responsibleId: 1,
    colorId,
    ...(ping ? { pingOffsets: ping } : {})
  })
  const id = Number(r?.id ?? r)
  created.activities.push(id)
  // ⚠ Разметка включается ОТДЕЛЬНЫМ вызовом: у `todo.add` параметра под тип описания нет, а
  // дефолт `2` показал бы BB-код исходником.
  if (bb) await call('crm.activity.update', { id, fields: { DESCRIPTION_TYPE: 3 } })
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
    colorId: GREEN,
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
    colorId: PINK,
    minutes: 15
  })
  await attachFile(warnId)
  info(`проблемы → дело ${warnId}`)

  save({ deal: created.deal, activities: created.activities, okId, warnId })

  // --- 2b. ТЕЛО ДЕЛА: у To-Do нет подвала с кнопками, всё уезжает в описание -------------------
  //
  // ⚠ Это и есть настоящий предмет выбора. Конфигурируемое дело раскладывало счётчики блоками и
  // давало кнопки «Открыть» и «Исходный файл»; у To-Do есть только `description`. Вопрос, на
  // который нельзя ответить из документации: понимает ли описание разметку, станет ли ссылка
  // кликабельной и во что превращается список проблем. Поэтому раскладываем три написания
  // одного и того же содержимого и смотрим.
  head('2b. Тело дела — три написания одного содержимого')

  const dealUrl = `https://${DOMAIN}/crm/deal/details/${created.deal}/`
  // ⚠ ФИНАЛЬНЫЙ ВИД (решение владельца 06.08.2026): BB-код, три именованных блока — Поставщик
  // (со ссылкой на карточку компании), Позиций, Сумма, — ниже список проблем, ссылка на созданную
  // сущность и совет. HTML отвергнут: живьём он не отрисовался.
  // ⚠ `DESCRIPTION_TYPE` обязан быть `3`. Дефолт у To-Do — `2`, и при нём BB-разметка показывается
  // ИСХОДНИКОМ: человек увидит `[B]Поставщик:[/B]` буквально. Забыть это поле = испортить каждое дело.
  const FINAL = ({ supplier, companyId, rows, matched, sum, problems, entityUrl, advice }) => [
    `[B]Поставщик:[/B] ${companyId ? `[URL=/crm/company/details/${companyId}/]${supplier}[/URL]` : supplier}`,
    `[B]Позиций:[/B] ${rows}${matched === null ? '' : ` · сопоставлено с каталогом: ${matched}`}`,
    `[B]Сумма:[/B] ${sum}`,
    ...(problems.length
      ? ['', `[B]Проблемы (${problems.length}):[/B]`, '[LIST]', ...problems.map(p => `[*]${p}`), '[/LIST]']
      : ['']),
    // ⚠ Ссылка и совет — ТАКИЕ ЖЕ подписанные блоки, как счётчики выше. Голой строкой внизу совет
    // не читался вовсе: владелец его просто не заметил на витрине. Подпись — это и есть то, что
    // отличает блок от хвоста текста.
    `[B]Сделка:[/B] [URL=${entityUrl}]Открыть карточку[/URL]`,
    // ⚠ Совет печатается только когда он ЕСТЬ: пустой блок «Что сделать:» обещал бы указание и не
    // давал его, а это хуже отсутствия блока.
    ...(advice ? ['', `[B]Что сделать:[/B] ${advice}`] : [])
  ].join('\n')

  const CONTENT = {
    plain: [
      'Поставщик: ООО «Ромашка»',
      'Позиций: 7 · сопоставлено с каталогом: 5',
      'Сумма: 10 320,00 BYN',
      '',
      'Проблемы (2):',
      '• Артикул «ZQ-51» в каталоге не найден — внесён произвольной позицией.',
      '• Единица «уп.» неизвестна — записана штука.',
      '',
      `Сделка: ${dealUrl}`
    ].join('\n'),
    bb: [
      '[B]Поставщик:[/B] ООО «Ромашка»',
      '[B]Позиций:[/B] 7 · сопоставлено с каталогом: 5',
      '[B]Сумма:[/B] 10 320,00 BYN',
      '',
      '[B]Проблемы (2):[/B]',
      '[LIST]',
      '[*]Артикул «ZQ-51» в каталоге не найден — внесён произвольной позицией.',
      '[*]Единица «уп.» неизвестна — записана штука.',
      '[/LIST]',
      `[URL=${dealUrl}]Открыть сделку[/URL]`
    ].join('\n'),
    html: [
      '<b>Поставщик:</b> ООО «Ромашка»<br>',
      '<b>Позиций:</b> 7 · сопоставлено с каталогом: 5<br>',
      '<b>Сумма:</b> 10 320,00 BYN<br><br>',
      '<b>Проблемы (2):</b><br>',
      '• Артикул «ZQ-51» в каталоге не найден — внесён произвольной позицией.<br>',
      '• Единица «уп.» неизвестна — записана штука.<br><br>',
      `<a href="${dealUrl}">Открыть сделку</a>`
    ].join('')
  }

  for (const [kind, description] of Object.entries(CONTENT)) {
    const id = await addTodo({
      title: `[тело: ${kind}] Импорт завершён с замечаниями`,
      description,
      colorId: PINK,
      minutes: 30
    })
    // DESCRIPTION_TYPE: 1 — простой текст, 3 — BB-код. Ставим осознанно, а не полагаемся на
    // дефолт: именно он решает, увидит человек разметку или её исходник.
    if (kind !== 'plain') {
      await raw('crm.activity.update', { id, fields: { DESCRIPTION_TYPE: kind === 'bb' ? 3 : 2 } })
    }
    const back = await call('crm.activity.get', { id })
    info(`${kind} → дело ${id}, DESCRIPTION_TYPE=${back.DESCRIPTION_TYPE}`)
  }
  // --- 2c. ФИНАЛЬНЫЙ ВИД обеих веток ----------------------------------------------------------
  head('2c. Финальный вид: BB-код, блоки, ссылка на поставщика, напоминание')

  // Компания нужна по-настоящему: ссылка на поставщика ведёт в её карточку, и проверить, что она
  // открывается, можно только имея карточку.
  const companyId = Number(await call('crm.company.add', { fields: { TITLE: 'ООО «Ромашка» (проба)' } }))
  created.company = companyId

  const finalOk = await addTodo({
    title: 'Импорт: ООО «Ромашка»',
    description: FINAL({
      supplier: 'ООО «Ромашка»',
      companyId,
      rows: 7,
      matched: 7,
      sum: '10 320,00 BYN',
      problems: [],
      entityUrl: dealUrl
    }),
    colorId: GREEN,
    minutes: 0,
    bb: true
  })
  await attachFile(finalOk)
  await call('crm.activity.update', { id: finalOk, fields: { COMPLETED: 'Y' } })
  info(`ФИНАЛ успех → дело ${finalOk}`)

  const finalWarn = await addTodo({
    title: 'Импорт: ООО «Ромашка»',
    description: FINAL({
      supplier: 'ООО «Ромашка»',
      companyId,
      rows: 7,
      matched: 5,
      sum: '10 320,00 BYN',
      problems: [
        'Артикул «ZQ-51» в каталоге не найден — внесён произвольной позицией.',
        'Единица измерения «уп.» неизвестна — записана штука.'
      ],
      entityUrl: dealUrl,
      advice: 'Чтобы позиции подбирались, заполните артикулы в каталоге товаров портала.'
    }),
    colorId: PINK,
    minutes: 15,
    bb: true,
    ping: [0]
  })
  await attachFile(finalWarn)
  info(`ФИНАЛ замечания → дело ${finalWarn}`)

  save({ deal: created.deal, company: companyId, activities: created.activities, okId, warnId, finalOk, finalWarn })

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
  console.log(`  Целевые дела: успех — colorId=${GREEN} (зелёный), замечания — colorId=${PINK} (розовый).`)
  console.log(`  Убрать: pnpm probe:todo --clean`)
}

try {
  await run()
} catch (e) {
  bad(String(e?.message ?? e))
  save({ deal: created.deal, activities: created.activities })
  process.exitCode = 1
}
