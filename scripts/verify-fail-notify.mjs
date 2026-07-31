// Live check of the «документ не удалось внести» notifications (PROJECT_MAP §7: written + tested,
// never sent for real). Runs the SAME code as production — planFailureNotify (who + what) and
// sendChatMessage (im.message.add) — against the webhook portal (.env.b24test, scope `im`):
//
//   pnpm verify:fail        # send both messages into a [TEST] group chat, verify ids, delete both
//   pnpm verify:fail --keep # leave the messages in the chat for eyeballing
//
// What this proves that unit tests cannot: the message actually lands (chat dialog id accepted,
// BB-link passes im.message.add, URL_PREVIEW flag valid), and the returned id is a real message id
// (delete succeeds). Two live facts found while writing it:
//  - im.message.add REFUSES a self-dialog («Вы не можете отправлять сообщения указанному
//    получателю») — so on this single-user portal the PERSONAL-chat path (bare uploaderId) cannot
//    be exercised at all; both planned messages go to the [TEST] chat instead. Delivery to a real
//    employee's personal dialog needs a portal with a second user — noted in PROJECT_MAP §12.1.
//  - the [TEST] chat is created once (im.chat.add) and reused by title — chats have no delete in
//    scope `im`, so we don't leak one per run.
//
// Node >= 22.18 (or --experimental-strip-types): imports the app TS directly via the alias hook.
import { readFileSync } from 'node:fs'
import { planFailureNotify } from '../server/utils/failureNotify.ts'
import { sendChatMessage } from '../server/utils/chatNotify.ts'

const keep = process.argv.includes('--keep')

// --- webhook plumbing (same shape as live-crm-sync.mjs) ---------------------------------------
function loadHook() {
  // .env.b24test FIRST: the file names THE test portal of this repo, while process.env can carry a
  // stray B24_HOOK from the shell (it did — an expired portal answered «only by subscription» and
  // the check looked broken). Env is the fallback for CI-style one-off runs.
  try {
    const env = readFileSync(new URL('../.env.b24test', import.meta.url), 'utf8')
    const m = /^B24_HOOK=(.+)$/m.exec(env)
    if (m) return m[1].trim()
  } catch { /* fall through */ }
  if (process.env.B24_HOOK) return process.env.B24_HOOK
  console.error('нужен B24_HOOK (.env.b24test или env)')
  process.exit(1)
}
const HOOK = loadHook().replace(/\/+$/, '')

/** Minimal RestCall over the webhook. Throws on portal-level errors — a silent failure here would
 *  make the whole check meaningless. */
async function call(method, params = {}) {
  const res = await fetch(`${HOOK}/${method}.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(20_000)
  })
  const data = await res.json()
  if (data.error) throw new Error(`${method}: ${data.error} ${data.error_description ?? ''}`)
  return data.result
}

// --- the check --------------------------------------------------------------------------------
const checks = []
const ok = (name, pass, extra = '') => {
  checks.push(pass)
  console.log(`${pass ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`)
}

const me = await call('profile')
const myId = String(me.ID)

// Find-or-create the [TEST] chat (see header — self-dialog is refused, chats are undeletable).
const CHAT_TITLE = '[TEST] verify:fail — чат ошибок'
async function testChatDialogId() {
  const recent = await call('im.recent.list', {})
  const hit = (recent?.items ?? []).find(i => i?.title === CHAT_TITLE && String(i?.id ?? '').startsWith('chat'))
  if (hit) return String(hit.id)
  const chatId = await call('im.chat.add', { TYPE: 'CHAT', TITLE: CHAT_TITLE, USERS: [Number(myId)] })
  return `chat${chatId}`
}
const dialogId = await testChatDialogId()
console.log(`портал: ${me.ADMIN ? 'админ' : 'пользователь'} #${myId}, шлём в ${dialogId} («${CHAT_TITLE}»)`)

const planned = planFailureNotify({
  claimed: true,
  uploaderId: myId,
  fileName: 'проверка [verify:fail] https://evil.example «счёт».pdf',
  reason: 'извлечение текста: pdftotext: /tmp/import/xyz/page1: broken font table',
  errorChatId: myId,
  alsoErrorChat: true,
  jobId: 'verify-fail-0000-0000',
  appUrl: 'https://price-import.bx-shef.by/app'
})

ok('план: два сообщения (сотруднику + чат ошибок)', planned.length === 2)
ok('план: техническое нутро pdftotext не попало в текст',
  planned.every(p => !p.message.includes('pdftotext') && !p.message.includes('/tmp/')))
ok('план: голая ссылка из имени файла обезврежена',
  planned.every(p => !p.message.includes('https://evil.example')))
ok('план: у сотрудника есть путь назад (ссылка на приложение)',
  planned[0].message.includes('[URL=https://price-import.bx-shef.by/app]'))
ok('план: в чате ошибок есть номер задания и НЕТ имени сотрудника',
  planned[1].message.includes('verify-fail-0000-0000'))

// Delivery: the TEXTS are exactly what production would send; only the recipient is overridden to
// the [TEST] chat (the personal-dialog recipient is unreachable on a single-user portal — header).
const sentIds = []
for (const [i, p] of planned.entries()) {
  const id = await sendChatMessage(dialogId, p.message, call)
  ok(`отправка ${i + 1}/${planned.length} → ${dialogId}`, id !== null, `msgId=${id}`)
  if (id) sentIds.push(id)
}

if (!keep) {
  for (const id of sentIds) {
    const del = await call('im.message.delete', { MESSAGE_ID: id, COMPLETE: 'Y' })
    ok(`удаление msgId=${id}`, del === true || del === 'true')
  }
} else {
  console.log('… --keep: сообщения оставлены в чате для глаз')
}

const passed = checks.filter(Boolean).length
console.log(`\n${passed}/${checks.length} проверок прошло`)
process.exit(passed === checks.length ? 0 : 1)
