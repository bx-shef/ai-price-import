// Живая приёмка #461: документ к отзыву читается ИЗ ВЛОЖЕНИЯ ДЕЛА таймлайна.
//
// Зачем скрипт, если есть тесты. Тесты гоняют ядро на фейках, а здесь проверяются ровно те факты
// портала, которые фейком не проверишь и о которых нельзя судить по документации:
//   1. дело с вложением находится нашим фильтром (`ORIGINATOR_ID` + `ORIGIN_ID` + `RESPONSIBLE_ID`);
//   2. `crm.activity.get` действительно отдаёт `FILES` с адресом (одного `list` для этого мало);
//   3. по этому адресу приходят ТЕ ЖЕ БАЙТЫ, что были вложены;
//   4. и главное — **сужение по сотруднику работает**: чужой ответственный не отдаёт документ.
//
// ⚠ Гоняется НАСТОЯЩАЯ `fetchActivityFile`, а не переписанный здесь запрос. Своя копия запроса
// проверяла бы догадку сама на себе — та же причина, что у `verify:article`.
//
// ⚠ Живая находка, ради которой всё и построено: портал отвечает на негодный токен **200 и
// HTML-страницей входа**, а не 401. Поэтому шаг 5 подсовывает испорченный адрес и утверждает, что
// ядро назовёт это `login-page`, а не примет страницу логина за документ.
//
//   pnpm verify:attach
import { assertTestPortal } from './lib/testPortalGuard.mjs'
import { liveOauth } from './lib/oauthToken.mjs'

const { fetchActivityFile, downloadAttachment } = await import('../server/utils/activityFileFetch.ts')

const { domain: DOMAIN, token: TOKEN } = await liveOauth()
assertTestPortal(`https://${DOMAIN}/`)

const ORIGINATOR = 'SH_APP_IMPORT_PRICE_AI'
const JOB_ID = `verify-attach-${Date.now()}`
// Байты узнаваемые: если вместо них приедет страница входа, расхождение будет видно сразу.
const BYTES = Buffer.from('%PDF-1.4\nПРОВЕРКА ВЛОЖЕНИЯ #461\n')
const MAX = 20 * 1024 * 1024

const call = async (method, params = {}) => {
  const r = await fetch(`https://${DOMAIN}/rest/${method}.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...params, auth: TOKEN })
  })
  const j = await r.json()
  if (j.error) throw new Error(`${method}: ${j.error} ${j.error_description || ''}`)
  return j.result
}

const ok = m => console.log(`\x1b[32m✓\x1b[0m ${m}`)
const fail = (m) => {
  console.error(`\x1b[31m✗\x1b[0m ${m}`)
  process.exitCode = 1
}

const deps = extra => ({ call, download: url => downloadAttachment(url, MAX), originatorCode: ORIGINATOR, maxBytes: MAX, fallbackName: `${JOB_ID}.pdf`, ...extra })

let companyId = 0
let activityId = 0
try {
  const me = await call('profile')
  const userId = Number(me.ID)
  if (!Number.isInteger(userId) || userId <= 0) throw new Error('не удалось определить сотрудника')

  // Владелец дела — компания: у дела обязан быть существующий владелец (#459), иначе портал
  // отвергает вызов. Заводим свою и уносим её в `finally`.
  companyId = Number(await call('crm.company.add', { fields: { TITLE: `[TEST] #461 ${JOB_ID}` } }))

  // ⚠ `todo.add` отдаёт ОБЪЕКТ `{id}`, а не число (живая находка): `Number(result)` давал `NaN`,
  // дело заводилось, а последующий `update` уходил в никуда.
  // ⚠ `deadline` у `todo.add` ОБЯЗАТЕЛЕН — без него «Could not find value for parameter {deadline}».
  const added = await call('crm.activity.todo.add', {
    ownerTypeId: 4,
    ownerId: companyId,
    title: `[TEST] проверка вложения ${JOB_ID}`,
    responsibleId: userId,
    deadline: new Date(Date.now() + 15 * 60_000).toISOString()
  })
  activityId = Number(added?.id ?? added)

  // ⚠ ПОСЛЕДОВАТЕЛЬНОСТЬ ТА ЖЕ, ЧТО В БОЮ, и это НЕ мелочь: вложение ставится ОТДЕЛЬНЫМ
  // `crm.activity.update`, а не полем внутри `todo.add`. Первая редакция этой проверки клала
  // `FILES` прямо в `todo.add` — портал принял вызов БЕЗ ошибки и файл молча не прикрепил, чтение
  // вернуло пусто, и я едва не записал это как «портал не отдаёт FILES», то есть обвинил портал в
  // своей ошибке. Проверка обязана повторять боевой путь дословно, иначе она проверяет не его.
  await call('crm.activity.update', {
    id: activityId,
    fields: { ORIGINATOR_ID: ORIGINATOR, ORIGIN_ID: JOB_ID }
  })
  await call('crm.activity.update', {
    id: activityId,
    fields: { FILES: [{ fileData: [`${JOB_ID}.pdf`, BYTES.toString('base64')] }] }
  })
  ok(`дело ${activityId} заведено с вложением, ответственный ${userId}`)

  // 1-3. Настоящий путь целиком: фильтр → чтение полей → скачивание.
  const got = await fetchActivityFile(JOB_ID, userId, deps())
  if (!got.ok) {
    fail(`документ не прочитан: ${got.miss}`)
  } else if (Buffer.from(got.file.base64, 'base64').equals(BYTES)) {
    ok(`документ прочитан и байты совпали (${got.file.name})`)
  } else {
    fail('байты НЕ совпали — вместо документа приехало что-то другое')
  }

  // 4. Несущая проверка приватности: чужой сотрудник ничего не получает.
  const alien = await fetchActivityFile(JOB_ID, userId + 100000, deps())
  if (alien.ok) fail('ЧУЖОЙ сотрудник получил документ — сужение по ответственному не работает')
  else ok(`чужой сотрудник документа не получает (${alien.miss})`)

  // 5. Ловушка портала: испорченный ключ доступа даёт 200 + HTML, и это НЕ документ.
  const spoiled = await fetchActivityFile(JOB_ID, userId, deps({
    download: async (url) => {
      const broken = url.replace(/auth=[^&]*/, 'auth=0000000000000000')
      return downloadAttachment(broken, MAX)
    }
  }))
  if (spoiled.ok) fail('страница входа принята за документ — проверка типа содержимого не работает')
  else ok(`негодный ключ доступа отбракован (${spoiled.miss})`)
} catch (e) {
  fail(String(e?.message || e))
} finally {
  // Уборка обязательна: скрипт пишет в живой портал.
  try {
    if (activityId) await call('crm.activity.delete', { id: activityId })
    if (companyId) await call('crm.company.delete', { id: companyId })
    ok('следы убраны')
  } catch (e) {
    console.error(`⚠ уборка не удалась, убрать вручную: дело ${activityId}, компания ${companyId} — ${e?.message || e}`)
  }
}
