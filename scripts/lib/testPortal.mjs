// Общая обвязка живых проверок: адрес портала, гард, тестовый чат, честная уборка.
//
// ⚠ Заведена потому, что каждый скрипт писал это заново и расходился в мелочах, а мелочи здесь
// необратимы: чат в Bitrix24 по REST НЕ удаляется. Разбор нашёл три разъезда сразу — один скрипт
// звал `im.recent.list` с `LIMIT: 200` и комментарием «дефолт 50 вытеснял давно молчавший чат, и
// каждый прогон создавал дубль», два новых звали без лимита; один умел обе формы ответа портала
// (`items` и голый массив), другой только первую; один проверял результат удаления, другой глотал
// отказ и всё равно печатал «удалено N».

import { readEnvValue } from './envFile.mjs'

/**
 * Адрес вебхука тест-портала.
 *
 * ⚠ Файл ЧИТАЕТСЯ ПЕРВЫМ, переменная окружения — запасная: в оболочке живёт `B24_HOOK` прежнего
 * портала, и проверка выглядит сломанной («REST по подписке»), хотя сломан адрес.
 * ⚠ Берётся ПОСЛЕДНЕЕ вхождение (семантика dotenv): дописав новый адрес в конец файла, разработчик
 * иначе продолжал бы ходить на прежний портал.
 */
export function readHook(envPath) {
  const fromFile = readEnvValue(envPath, 'B24_HOOK', { required: false })
  const hook = fromFile || (process.env.B24_HOOK ?? '').trim().replace(/^["']|["']$/g, '')
  if (!hook) throw new Error('нет B24_HOOK: положите вебхук в .env.b24test')
  return hook
}

/** REST-вызов вебхуком. Адрес (в нём секрет) в вывод не попадает — только метод и код ошибки. */
export function makeCall(hook) {
  const base = hook.replace(/\/?$/, '/')
  return async function call(method, params = {}) {
    let data
    try {
      const res = await fetch(`${base}${method}.json`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params)
      })
      data = await res.json()
    } catch (e) {
      // ⚠ Своя ошибка вместо проброса: у сетевого отказа `fetch` в `cause` лежит адрес запроса,
      // то есть секрет вебхука — он попал бы в стек, в вывод и на скриншот.
      // eslint-disable-next-line preserve-caught-error -- cause и есть утечка, см. выше
      throw new Error(`${method}: сеть недоступна (${e instanceof Error ? e.name : 'ошибка'})`)
    }
    if (data.error) throw new Error(`${method}: ${data.error} ${data.error_description ?? ''}`)
    return data.result
  }
}

/**
 * Найти или завести `[TEST]`-чат.
 *
 * ⚠ `LIMIT: 200` (максимум) обязателен: дефолт 50 вытесняет давно молчавший чат с первой страницы,
 * и каждый прогон заводит дубль — неудаляемый.
 * ⚠ Обе формы ответа: часть версий портала отдаёт `{items}`, часть — голый массив; поддержка одной
 * из них означает новый чат на каждом запуске у половины порталов.
 */
export async function findOrCreateTestChat(call, title, myId) {
  const recent = await call('im.recent.list', { LIMIT: 200 })
  const items = Array.isArray(recent?.items) ? recent.items : (Array.isArray(recent) ? recent : [])
  const hit = items.find(i => String(i?.title ?? '') === title)
  if (hit) {
    const raw = hit.chat_id ?? hit.id
    return String(raw).startsWith('chat') ? String(raw) : `chat${raw}`
  }
  return `chat${await call('im.chat.add', { TYPE: 'CHAT', TITLE: title, USERS: [Number(myId)] })}`
}

/**
 * Удалить сообщения проверки и сказать правду о результате.
 *
 * ⚠ `COMPLETE:'Y'` — иначе портал оставляет след «сообщение удалено».
 * ⚠ Отказ НЕ глотается и НЕ выдаётся за успех: прежняя версия печатала «удалено 6» по числу
 * попыток, и зелёный итог был совместим с шестью оставшимися в чате сообщениями.
 */
export async function deleteMessages(call, ids) {
  const stuck = []
  for (const id of ids) {
    try {
      const done = await call('im.message.delete', { MESSAGE_ID: id, COMPLETE: 'Y' })
      if (done !== true) stuck.push(id)
    } catch { stuck.push(id) }
  }
  if (stuck.length) console.error(`✗ НЕ удалены сообщения ${stuck.join(', ')} — уберите вручную`)
  else if (ids.length) console.log(`\nудалено сообщений: ${ids.length}`)
  return stuck
}

/**
 * Уборка и по прерыванию тоже.
 *
 * ⚠ `try/finally` не выполняется на SIGINT: процесс завершается без раскрутки, и Ctrl-C в момент,
 * когда сообщение уже отправлено, оставляет его в чате — у `verify:legal` это текст, неотличимый
 * от настоящего уведомления об изменении лицензии.
 */
export function cleanupOnSignals(run) {
  let done = false
  const once = async () => {
    if (done) return
    done = true
    await run().catch(() => {})
    process.exit(130)
  }
  process.on('SIGINT', once)
  process.on('SIGTERM', once)
}
