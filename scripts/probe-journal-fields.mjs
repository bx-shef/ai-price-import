// Разведка полей дела для журнала импортов (#495).
//
// ЗАЧЕМ. Журнал сегодня читает у дела четыре поля и показывает заголовок, дату и «закрыто ли».
// Владелец просит показывать РЕЗУЛЬТАТ (позиции, сумму, проблемы), ССЫЛКУ НА ФАЙЛ и ЦВЕТ САМОГО
// ДЕЛА. Прежде чем это обещать, надо ответить на вопросы, ответы на которые в справочнике либо
// расходятся, либо отсутствуют, а прошлый прогон (`probe-activity-files`, вебхуком) прямо показал,
// что часть полей REST не отдаёт:
//
//   1. Что возвращает `crm.activity.get` по нашему ДЕЛУ: есть ли `DESCRIPTION`, `FILES`, и в каком
//      виде приезжает ЦВЕТ (`COLOR`? `SETTINGS`? отдельного поля может не быть вовсе).
//   2. Отдаёт ли эти же поля `crm.activity.list` при явном `select` — то есть можно ли обойтись
//      одним списком вместо «список + запрос на каждую строку».
//   3. Переживает ли цвет и завершённость правку через `crm.activity.update` (журнал обязан
//      показывать ТО ЖЕ, что человек видит в карточке, а её могли править руками).
//
// ⚠ Скрипт ПИШЕТ на портал (сделка-носитель + дело) и убирает за собой в `finally`. Только
// тест-портал (`assertTestPortal`).
//
// ⚠ Ходит ВЕБХУКОМ. Значит часть картины он не покажет: `crm.activity.get` в бою зовётся под
// OAuth-токеном портала, и прошлый прогон вебхуком уже расходился с живой находкой #461 («в FILES
// приезжают id и url»). Поэтому вывод скрипта — не приговор, а список фактов с пометкой, каким
// контекстом они сняты.
//
//   node --experimental-strip-types scripts/probe-journal-fields.mjs
import { assertTestPortal } from './lib/testPortalGuard.mjs'
import { readEnvValue } from './lib/envFile.mjs'

const WEBHOOK = readEnvValue('.env.b24test', 'B24_TEST_WEBHOOK')
assertTestPortal(WEBHOOK)

const call = async (method, params = {}) => {
  const r = await fetch(`${WEBHOOK}${method}.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params)
  })
  const j = await r.json().catch(() => null)
  if (j?.error) throw new Error(`${method}: ${j.error} ${j.error_description ?? ''}`)
  return j?.result
}

const ORIGINATOR = 'SH_PROBE_JOURNAL'
const jobId = `probe-${Date.now()}`
let dealId = 0
let activityId = 0

try {
  dealId = await call('crm.deal.add', { fields: { TITLE: '[PROBE] журнал — носитель дела' } })
  console.log('сделка-носитель', dealId)

  // Дело строится ТАК ЖЕ, как в бою: цвет, описание BB-разметкой, срок. Иначе проверялось бы не то.
  const added = await call('crm.activity.todo.add', {
    ownerTypeId: 2,
    ownerId: dealId,
    title: '[PROBE] Импорт: ООО Ромашка',
    description: '[B]Поставщик:[/B] ООО Ромашка\n[B]Позиции:[/B] 14\n[B]Сумма:[/B] 1 200,00 BYN',
    colorId: '7',
    deadline: new Date(Date.now() + 3600_000).toISOString()
  })
  activityId = Number(added?.id ?? added)
  console.log('дело', activityId)

  await call('crm.activity.update', {
    id: activityId,
    fields: { ORIGINATOR_ID: ORIGINATOR, ORIGIN_ID: jobId, DESCRIPTION_TYPE: 3 }
  })

  // ⚠ Вложение ставится ОТДЕЛЬНЫМ `update` — ровно как в бою (#461): в первой редакции проверки
  // файл клали внутрь `todo.add`, портал принимал вызов без ошибки и молча ничего не прикреплял.
  await call('crm.activity.update', {
    id: activityId,
    fields: { FILES: [{ fileData: ['probe.txt', Buffer.from('проба').toString('base64')] }] }
  })

  const full = await call('crm.activity.get', { id: activityId })
  console.log('\n=== crm.activity.get: КЛЮЧИ ===')
  console.log(Object.keys(full ?? {}).sort().join(', '))
  for (const k of ['DESCRIPTION', 'DESCRIPTION_TYPE', 'FILES', 'COLOR', 'SETTINGS', 'COMPLETED', 'SUBJECT']) {
    console.log(`  ${k}:`, JSON.stringify(full?.[k])?.slice(0, 200))
  }

  const listed = await call('crm.activity.list', {
    filter: { ORIGINATOR_ID: ORIGINATOR, ORIGIN_ID: jobId },
    select: ['ID', 'SUBJECT', 'COMPLETED', 'CREATED', 'DESCRIPTION', 'FILES', 'COLOR', 'SETTINGS'],
    start: 0
  })
  const row = Array.isArray(listed) ? listed[0] : null
  console.log('\n=== crm.activity.list с явным select: КЛЮЧИ ===')
  console.log(Object.keys(row ?? {}).sort().join(', '))
  for (const k of ['DESCRIPTION', 'FILES', 'COLOR', 'SETTINGS']) {
    console.log(`  ${k}:`, JSON.stringify(row?.[k])?.slice(0, 200))
  }

  console.log('\n=== ВЫВОД ===')
  console.log('описание в списке:', row && 'DESCRIPTION' in row ? 'ЕСТЬ' : 'НЕТ')
  console.log('цвет в get:', full && ('COLOR' in full || 'SETTINGS' in full) ? 'есть какое-то поле' : 'НЕТ')
} finally {
  if (activityId) await call('crm.activity.delete', { id: activityId }).catch(() => {})
  if (dealId) await call('crm.deal.delete', { id: dealId }).catch(() => {})
  console.log('\nубрано')
}
