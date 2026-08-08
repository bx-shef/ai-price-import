// Живая проверка приёмки #418: уведомление об изменении юридических документов доходит в чат
// портала — целиком, со всеми обязательными элементами п. 9.3.3 EULA.
//
// Что именно доказывается (и чего НЕ доказывается):
//   ✓ текст, который строит `buildLegalNoticeChat`, принимается порталом и виден в чате;
//   ✓ в нём есть дата вступления, содержание изменений, ссылки на архив (на прежнюю редакцию —
//     только если она есть; сегодня редакция одна, и вторая ссылка не строится) и право удалить
//     приложение без последствий — без любого из них уведомление юридически не работает, но
//     выглядит нормально, и это выяснилось бы только в споре;
//   ✓ ссылки ведут на живые адреса (проверяются запросом, а не глазами).
//   ✗ НЕ доказывается суточный проход рассылки и отметки в базе: они идут по OAuth-токену
//     установленного портала, а здесь вебхук. Их проверять на живой установке.
//
// ⚠ Объявление берётся ИЗ РЕЕСТРА, если он не пуст, и достраивается синтетически только когда
// объявлять нечего. Первая редакция скрипта всегда строила синтетику — и это ровно тот класс
// дефекта, за которым в этом проекте охотятся: в день настоящей публикации проверка прогоняла бы
// НЕ ТО объявление (чужой документ, чужой срок, чужой перечень изменений) и уверенно печатала
// зелёные галочки. Проверять надо то, что уедет клиентам. Сообщение шлётся в [TEST]-чат и
// удаляется.
import { assertTestPortal } from './lib/testPortalGuard.mjs'
import { cleanupOnSignals, deleteMessages, findOrCreateTestChat, makeCall, readHook } from './lib/testPortal.mjs'
import { NOTICE_DAYS, buildLegalNotice, buildLegalNoticeChat, effectiveDate, formatRuDate, noticeProblems } from '../app/utils/legalNotice.ts'
import { sendChatMessage } from '../server/utils/chatNotify.ts'

const CHAT_TITLE = '[TEST] verify:legal-notice — уведомление об изменении документов'
const SITE = 'https://price-import.bx-shef.by'
const keep = process.argv.includes('--keep')

const HOOK = readHook(new URL('../.env.b24test', import.meta.url))
assertTestPortal(HOOK)
const call = makeCall(HOOK)

let failed = 0
const ok = (label, cond, note = '') => {
  console.log(`${cond ? '✓' : '✗'} ${label}${note ? ` — ${note}` : ''}`)
  if (!cond) failed++
}

// Берём РЕАЛЬНЫЕ даты из архива редакций: выдуманная дата дала бы ссылку в 404 и проверка ссылок
// стала бы декоративной.
const { findArchiveDoc, isCurrentEdition } = await import('../app/utils/legalArchive.ts')
const eula = findArchiveDoc('eula')
if (!eula) throw new Error('в реестре нет документа eula')
// ⚠ Действующая редакция — та, у которой нет даты замены, а НЕ первая в списке: порядок вывода не
// обязан совпадать со смыслом, и на первой же смене редакции проверка молча ушла бы на старую.
const current = eula.editions.find(isCurrentEdition)
if (!current) throw new Error('в реестре eula нет действующей редакции')

const { PENDING_LEGAL_EDITIONS } = await import('../app/config/legalNotice.ts')
/** Настоящее объявление, если оно есть: проверяем ровно то, что уйдёт лицензиатам. */
const announced = PENDING_LEGAL_EDITIONS[0]
if (announced) {
  console.log(`объявление ИЗ РЕЕСТРА: ${announced.slug} от ${announced.date}`)
} else {
  console.log('реестр объявлений пуст — прогоняем синтетическое объявление')
}

const synthetic = {
  slug: 'eula',
  title: eula.title,
  date: current.date,
  publishedAt: current.date,
  material: true,
  changes: [
    'Добавлен раздел о переносе приложения на сервер лицензиата.',
    'Срок хранения отзывов сокращён до двенадцати месяцев.'
  ],
  // Прежняя редакция — настоящая заменённая, если она есть: без неё вторая ссылка не строится
  // вовсе, и проверка «обе ссылки на месте» проходила бы, ничего не проверяя.
  previousDate: eula.editions.find(e => !isCurrentEdition(e))?.date ?? null
}

const edition = announced ?? synthetic
// Ссылка строится по дате редакции ЭТОГО документа, поэтому у настоящего объявления проверяем его
// собственный архив, а не архив лицензии.
const editionDoc = findArchiveDoc(edition.slug)
if (!editionDoc) throw new Error(`в реестре архива нет документа ${edition.slug}`)

ok('объявление проходит проверку перед публикацией', noticeProblems(edition).length === 0,
  noticeProblems(edition).join('; '))

const eff = formatRuDate(effectiveDate(edition))
const notice = buildLegalNotice(edition)
const text = buildLegalNoticeChat(edition, p => `${SITE}${p}`)

ok('названа дата вступления', text.includes(eff), eff)
ok('сказано, ЧТО меняется', edition.changes.every(c => text.includes(c)))
ok('есть ссылка на новую редакцию', text.includes(`${SITE}${notice.newHref}`))
ok('названо право удалить приложение без последствий', /удалить с портала до .*без последствий/.test(text))

// ⚠ Проверяем ИМЕННО 30 дней, а не «дата сдвинулась»: 10 дней (несущественное изменение) сдвиг тоже
// дают, и прежняя формулировка была верна для обоих сроков — то есть не проверяла ничего.
const days = Math.round(
  (Date.parse(`${effectiveDate(edition)}T00:00:00Z`) - Date.parse(`${edition.publishedAt}T00:00:00Z`)) / 86_400_000
)
// ⚠ Ожидаемый срок берётся ИЗ ПРИЗНАКА существенности этого объявления, а не зашит числом:
// синтетика была существенной, настоящая правка может быть любой, и зашитые 30 дней объявляли бы
// исправное объявление сломанным (или наоборот — молчали бы о сроке короче обещанного).
const wantDays = edition.material ? NOTICE_DAYS.material : NOTICE_DAYS.minor
ok(`срок — ${wantDays} дн. (изменение ${edition.material ? 'существенное' : 'обычное'})`, days === wantDays, `${days} дн.`)

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
const dialogId = await findOrCreateTestChat(call, CHAT_TITLE, String(me.ID))

// ⚠ Первой строкой — пометка «это проверка»: текст ниже выглядит настоящим уведомлением об
// изменении лицензии (реальная дата редакции, рабочая ссылка, право удалить приложение). Пока
// сообщение висит в чате, любой прочитавший обязан видеть, что оно техническое.
const MARK = '⚠ ПРОВЕРКА, это НЕ уведомление — техническое сообщение, его сейчас удалят.'

let id = null
cleanupOnSignals(() => deleteMessages(call, id && !keep ? [id] : []))
try {
  id = await sendChatMessage(dialogId, `${MARK}\n\n${text}`, call)
  ok('уведомление доставлено в чат портала', id !== null, `msgId=${id}`)

  // Прочитать обратно: портал мог принять вызов и обрезать/переварить текст.
  if (id) {
    // ⚠ По id, а не «последнее в диалоге»: чат переиспользуется между прогонами и может нести
    // остаток после `--keep` или прерывания — тогда проверка подтвердила бы ПРОШЛУЮ доставку.
    const back = await call('im.dialog.messages.get', { DIALOG_ID: dialogId, LIMIT: 20 })
    const got = String((back?.messages ?? []).find(m => String(m.id) === String(id))?.text ?? '')
    ok('текст в чате не обрезан', got.includes(edition.changes[1]), `${got.length} знаков`)
    ok('ссылка на новую редакцию уцелела в чате', got.includes(notice.newHref))
    ok('ссылка на прежнюю редакцию уцелела в чате',
      notice.currentHref === null || got.includes(notice.currentHref),
      notice.currentHref ?? 'прежней редакции нет — проверять нечего')
  }
} finally {
  // ⚠ Уборка в `finally` и БЕЗ глотания отказа: не удалённое сообщение — это оставшийся в чате текст,
  // который читается как настоящее уведомление. Молчаливый `catch` прятал бы ровно это.
  if (id && !keep && (await deleteMessages(call, [id])).length) failed++
}

console.log(failed ? `\n❌ провалено: ${failed}` : '\n✅ все проверки прошли')
process.exit(failed ? 1 : 0)
