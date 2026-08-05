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
import { assertTestPortal } from './lib/testPortalGuard.mjs'
import { cleanupOnSignals, deleteMessages, findOrCreateTestChat, makeCall, readHook } from './lib/testPortal.mjs'
import { PROVIDER_FAILURE_KINDS, describeLlmFailure, llmErrorSignature, llmFailureMessage } from '../server/agent/llmFailure.ts'
import { planFailureNotify } from '../server/utils/failureNotify.ts'
import { MAX_CHAT_REASON, sendChatMessage } from '../server/utils/chatNotify.ts'

const CHAT_TITLE = '[TEST] verify:llm-failure — отказы распознавания'
const keep = process.argv.includes('--keep')

const HOOK = readHook(new URL('../.env.b24test', import.meta.url))
assertTestPortal(HOOK)
const call = makeCall(HOOK)

let failed = 0
const ok = (label, cond, note = '') => {
  console.log(`${cond ? '✓' : '✗'} ${label}${note ? ` — ${note}` : ''}`)
  if (!cond) failed++
}

const me = await call('profile')
const myId = String(me.ID)

const dialogId = await findOrCreateTestChat(call, CHAT_TITLE, myId)
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
cleanupOnSignals(() => deleteMessages(call, keep ? [] : sent.map(m => m.id)))
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

    const forEmployee = planned[0].message
    const id = await sendChatMessage(dialogId, forEmployee, call)
    ok(`${kind}: доставлено в чат`, id !== null, `msgId=${id}`)
    if (id) sent.push({ id, kind, message })
  }

  // ⚠ Обрыв проверяется по ПРОЧИТАННОМУ ИЗ ПОРТАЛА тексту, а не по локально построенному: прежняя
  // версия сверяла строку саму с собой, то есть зелёный результат был совместим с порталом,
  // который обрезал каждое сообщение. Читаем по id, а не «последнее в диалоге»: чат переиспользуется
  // между прогонами и может содержать остатки после `--keep` или прерывания.
  const back = await call('im.dialog.messages.get', { DIALOG_ID: dialogId, LIMIT: 50 })
  const byId = new Map((back?.messages ?? []).map(m => [String(m.id), String(m.text ?? '')]))
  for (const { id, kind, message } of sent) {
    const got = byId.get(String(id)) ?? ''
    // Хвост текста — это ровно совет, что делать; на нём и обрывалось в #373.
    ok(`${kind}: текст доехал целиком, не обрезан`,
      got.includes(message.slice(-24)), `${got.length} знаков, предел причины ${MAX_CHAT_REASON}`)
    ok(`${kind}: в чате нет строки провайдера`,
      !/api.?key|upstream|insufficient_quota|context length/i.test(got))
  }

  // Подпись для журнала: коды остаются, ключ и любой не-латинский текст — нет.
  const sig = llmErrorSignature(REAL_ERRORS.auth)
  ok('журнал: хвост ключа не остаётся', !sig.includes('test'), sig)
  ok('журнал: кириллицы (наименований, контрагентов) не остаётся',
    !/[А-Яа-яЁё]/.test(llmErrorSignature('ошибка при разборе ООО «Ромашка» накладная')))
  ok('журнал: латинского наименования и сумм не остаётся',
    !/ENERGOSBYT|ACME|191234567|10320/.test(
      llmErrorSignature('400 ACME ENERGOSBYT LTD УНП 191234567 сумма 10320.00')))

  // Каждый класс говорит своим текстом — иначе классификация декоративна.
  const texts = new Set(PROVIDER_FAILURE_KINDS.map(llmFailureMessage))
  ok('у каждого класса свой текст', texts.size === PROVIDER_FAILURE_KINDS.length)
} finally {
  // ⚠ Уборка в `finally`: падение в середине цикла иначе оставляло бы половину сообщений в чате —
  // ровно тот мусор, ради которого заведён `[TEST]`-чат и гард портала.
  if (!keep && (await deleteMessages(call, sent.map(m => m.id))).length) failed++
}

console.log(failed ? `\n❌ провалено: ${failed}` : '\n✅ все проверки прошли')
process.exit(failed ? 1 : 0)
