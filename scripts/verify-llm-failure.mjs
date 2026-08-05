// Живая проверка приёмки #416: отказ сервиса распознавания доходит до чата портала ВНЯТНЫМ
// текстом, целиком и без утечек.
//
// Зачем отдельно от `verify:fail`: тот проверяет доставку вообще (план + `im.message.add`) на одном
// вымышленном отказе извлечения. Здесь проверяется ровно то, что обещает п. 8.4 EULA — что при
// отказе ПРОВАЙДЕРА человек получает объяснение, а не строку провайдера. Проверяются ВСЕ классы:
// каждый ходит своим текстом, и обрыв на пределе чата у любого из них означал бы совет, до которого
// сотрудник не дочитает (так уже было в #373 — сообщение обрывалось перед словами, что делать).
//
// ⚠ Сообщения шлются в [TEST]-чат и удаляются. Портал берётся из `.env.b24test` (в репозиторий не
// коммитится), скоуп вебхука — `im`.
import { readFileSync } from 'node:fs'
import { assertTestPortal } from './lib/testPortalGuard.mjs'
import { PROVIDER_FAILURE_KINDS, describeLlmFailure, llmErrorSignature, llmFailureMessage } from '../server/agent/llmFailure.ts'
import { planFailureNotify } from '../server/utils/failureNotify.ts'
import { MAX_CHAT_REASON, sendChatMessage } from '../server/utils/chatNotify.ts'

const CHAT_TITLE = '[TEST] verify:llm-failure — отказы распознавания'
const keep = process.argv.includes('--keep')

function hook() {
  // ⚠ Файл ПЕРВЫМ, переменная окружения — запасным. Тот же капкан, что описан в
  // `verify-fail-notify.mjs`: в оболочке живёт `B24_HOOK` прежнего портала, и он отвечает
  // «REST is available only by subscription» — проверка выглядит сломанной, хотя сломан адрес.
  try {
    const m = /^B24_HOOK=(.+)$/m.exec(readFileSync(new URL('../.env.b24test', import.meta.url), 'utf8'))
    if (m) return m[1].trim()
  } catch { /* нет файла — ниже переменная или честная ошибка */ }
  if (process.env.B24_HOOK) return process.env.B24_HOOK
  throw new Error('нет B24_HOOK: положите вебхук в .env.b24test')
}

const HOOK = hook()
assertTestPortal(HOOK)
const base = HOOK.replace(/\/?$/, '/')
async function call(method, params = {}) {
  const res = await fetch(`${base}${method}.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params)
  })
  const data = await res.json()
  if (data.error) throw new Error(`${method}: ${data.error} ${data.error_description ?? ''}`)
  return data.result
}

let failed = 0
const ok = (label, cond, note = '') => {
  console.log(`${cond ? '✓' : '✗'} ${label}${note ? ` — ${note}` : ''}`)
  if (!cond) failed++
}

const me = await call('profile')
const myId = String(me.ID)

async function testChat() {
  const recent = await call('im.recent.list', {})
  const items = Array.isArray(recent?.items) ? recent.items : (Array.isArray(recent) ? recent : [])
  const hit = items.find(i => String(i.title ?? '') === CHAT_TITLE)
  if (hit) {
    const raw = hit.chat_id ?? hit.id
    return String(raw).startsWith('chat') ? String(raw) : `chat${raw}`
  }
  return `chat${await call('im.chat.add', { TYPE: 'CHAT', TITLE: CHAT_TITLE, USERS: [Number(myId)] })}`
}
const dialogId = await testChat()
console.log(`портал: #${myId}, шлём в ${dialogId} («${CHAT_TITLE}»)\n`)

// Строки провайдеров — НАСТОЯЩИЕ, снятые живыми прогонами. Догадка о формулировках проверяла бы
// регулярки сами на себе.
const REAL_ERRORS = {
  'auth': '401 401 Authentication Fails, Your api key: ****test is invalid',
  'quota': '429 You exceeded your current quota, insufficient_quota',
  'unavailable': '503 Service Unavailable: upstream connect error',
  'too-long': '400 This model\'s maximum context length is 65536 tokens',
  'unparsable': 'модель не извлекла JSON: unexpected token < in JSON at position 0',
  'unknown': 'что-то пошло не так'
}

// ⚠ Только классы ОТКАЗА ПРОВАЙДЕРА: класс `own` — это наши собственные сообщения (нет таблицы,
// слишком много позиций), у него нет строки провайдера и проверять здесь нечего.
const sent = []
try {
  for (const kind of PROVIDER_FAILURE_KINDS) {
    const raw = REAL_ERRORS[kind]
    const { kind: got, message } = describeLlmFailure(raw)
    ok(`${kind}: настоящая строка провайдера классифицируется верно`, got === kind, `получено «${got}»`)

    // Ключевое утверждение задачи: наружу не уходит ни строка провайдера, ни секрет, ни текст документа.
    ok(`${kind}: строки провайдера нет в тексте для человека`,
      !message.includes(raw) && !/api.?key|token|401|429|503|upstream|JSON/i.test(message))

    const planned = planFailureNotify({
      claimed: true,
      uploaderId: myId,
      fileName: 'накладная №77 от ООО «Ромашка».pdf',
      reason: message,
      errorChatId: myId,
      alsoErrorChat: true,
      jobId: `verify-llm-${kind}`,
      appUrl: 'https://price-import.bx-shef.by/app'
    })

    // Обрыв на пределе чата означал бы совет, до которого сотрудник не дочитает.
    const forEmployee = planned[0].message
    ok(`${kind}: текст доезжает целиком, не обрезан`,
      forEmployee.includes(message.slice(-24)), `${message.length} ≤ ${MAX_CHAT_REASON}`)

    const id = await sendChatMessage(dialogId, forEmployee, call)
    ok(`${kind}: доставлено в чат`, id !== null, `msgId=${id}`)
    if (id) sent.push(id)
  }

  // Подпись для журнала: коды остаются, ключ и любой не-латинский текст — нет.
  const sig = llmErrorSignature(REAL_ERRORS.auth)
  ok('журнал: эхо ключа вырезано', !sig.includes('test') && sig.includes('<hidden>'), sig)
  ok('журнал: кириллицы (наименований, контрагентов) не остаётся',
    !/[А-Яа-яЁё]/.test(llmErrorSignature('ошибка при разборе ООО «Ромашка» накладная')))

  // Каждый класс говорит своим текстом — иначе классификация декоративна.
  const texts = new Set(PROVIDER_FAILURE_KINDS.map(llmFailureMessage))
  ok('у каждого класса свой текст', texts.size === PROVIDER_FAILURE_KINDS.length)
} finally {
  // ⚠ Уборка в `finally`: падение в середине цикла иначе оставляло бы половину сообщений в чате —
  // ровно тот мусор, ради которого заведён `[TEST]`-чат и гард портала.
  if (!keep && sent.length) {
    for (const id of sent) await call('im.message.delete', { MESSAGE_ID: id }).catch(() => {})
    console.log(`\nудалено сообщений: ${sent.length}`)
  }
}

console.log(failed ? `\n❌ провалено: ${failed}` : '\n✅ все проверки прошли')
process.exit(failed ? 1 : 0)
