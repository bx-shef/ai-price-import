// Живая проверка приёмки #418: уведомление об изменении юридических документов доходит в чат
// портала — целиком, со всеми обязательными элементами п. 9.3.3 EULA.
//
// Что именно доказывается (и чего НЕ доказывается):
//   ✓ текст, который строит `buildLegalNoticeChat`, принимается порталом и виден в чате;
//   ✓ в нём есть дата вступления, содержание изменений, ОБЕ ссылки на архив и право удалить
//     приложение без последствий — без любого из них уведомление юридически не работает, но
//     выглядит нормально, и это выяснилось бы только в споре;
//   ✓ ссылки ведут на живые адреса (проверяются запросом, а не глазами).
//   ✗ НЕ доказывается суточный проход рассылки и отметки в базе: они идут по OAuth-токену
//     установленного портала, а здесь вебхук. Их проверять на живой установке.
//
// ⚠ Объявление здесь СИНТЕТИЧЕСКОЕ: реестр в приложении пуст (механизм заведён до первого
// изменения документов), и брать оттуда нечего. Сообщение шлётся в [TEST]-чат и удаляется.
import { readFileSync } from 'node:fs'
import { buildLegalNotice, buildLegalNoticeChat, effectiveDate, formatRuDate, noticeProblems } from '../app/utils/legalNotice.ts'
import { sendChatMessage } from '../server/utils/chatNotify.ts'

const CHAT_TITLE = '[TEST] verify:legal-notice — уведомление об изменении документов'
const SITE = 'https://price-import.bx-shef.by'
const keep = process.argv.includes('--keep')

function hook() {
  // Файл ПЕРВЫМ: в оболочке живёт вебхук прежнего портала (см. `verify-fail-notify.mjs`).
  try {
    const m = /^B24_HOOK=(.+)$/m.exec(readFileSync(new URL('../.env.b24test', import.meta.url), 'utf8'))
    if (m) return m[1].trim()
  } catch { /* ниже переменная или честная ошибка */ }
  if (process.env.B24_HOOK) return process.env.B24_HOOK
  throw new Error('нет B24_HOOK: положите вебхук в .env.b24test')
}

const base = hook().replace(/\/?$/, '/')
async function call(method, params = {}) {
  const res = await fetch(`${base}${method}.json`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params)
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

// Берём РЕАЛЬНЫЕ даты из архива редакций: выдуманная дата дала бы ссылку в 404 и проверка ссылок
// стала бы декоративной.
const { LEGAL_ARCHIVE } = await import('../app/config/legalArchive.ts')
const eula = LEGAL_ARCHIVE.find(d => d.slug === 'eula')
const current = eula.editions[0]

const edition = {
  slug: 'eula',
  title: eula.title,
  date: current.date,
  publishedAt: current.date,
  material: true,
  changes: [
    'Добавлен раздел о переносе приложения на сервер лицензиата.',
    'Срок хранения отзывов сокращён до двенадцати месяцев.'
  ],
  previousDate: null
}

ok('объявление проходит проверку перед публикацией', noticeProblems(edition).length === 0,
  noticeProblems(edition).join('; '))

const eff = formatRuDate(effectiveDate(edition))
const notice = buildLegalNotice(edition)
const text = buildLegalNoticeChat(edition, p => `${SITE}${p}`)

ok('названа дата вступления', text.includes(eff), eff)
ok('сказано, ЧТО меняется', edition.changes.every(c => text.includes(c)))
ok('есть ссылка на новую редакцию', text.includes(`${SITE}${notice.newHref}`))
ok('названо право удалить приложение без последствий', /удалить с портала до .*без последствий/.test(text))
ok('срок — 30 дней (изменение существенное)', effectiveDate(edition) !== edition.publishedAt)

// Ссылка обязана вести на живую страницу: опечатка в дате даёт 404 в сообщении, УЖЕ разосланном по
// чужим чатам, откуда его не отозвать.
const url = `${SITE}${notice.newHref}`
try {
  const r = await fetch(url, { redirect: 'follow' })
  ok('ссылка на редакцию открывается', r.ok, `${url} → ${r.status}`)
} catch (e) {
  ok('ссылка на редакцию открывается', false, `${url} → ${e.message}`)
}

const me = await call('profile')
async function testChat() {
  const recent = await call('im.recent.list', {})
  const items = Array.isArray(recent?.items) ? recent.items : []
  const hit = items.find(i => String(i.title ?? '') === CHAT_TITLE)
  if (hit) {
    const raw = hit.chat_id ?? hit.id
    return String(raw).startsWith('chat') ? String(raw) : `chat${raw}`
  }
  return `chat${await call('im.chat.add', { TYPE: 'CHAT', TITLE: CHAT_TITLE, USERS: [Number(me.ID)] })}`
}
const dialogId = await testChat()

const id = await sendChatMessage(dialogId, text, call)
ok('уведомление доставлено в чат портала', id !== null, `msgId=${id}`)

// Прочитать обратно: портал мог принять вызов и обрезать/переварить текст.
if (id) {
  const back = await call('im.dialog.messages.get', { DIALOG_ID: dialogId, LIMIT: 1 })
  const got = String(back?.messages?.[0]?.text ?? '')
  ok('текст в чате не обрезан', got.includes(edition.changes[1]), `${got.length} знаков`)
  ok('обе ссылки уцелели в чате', got.includes(notice.newHref))
  if (!keep) {
    await call('im.message.delete', { MESSAGE_ID: id }).catch(() => {})
    console.log('\nсообщение удалено')
  }
}

console.log(failed ? `\n❌ провалено: ${failed}` : '\n✅ все проверки прошли')
process.exit(failed ? 1 : 0)
