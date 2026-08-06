// Витрина для решения по #328 — раскладывает варианты подачи документа в ОДНОЙ сделке, чтобы
// владелец сравнил их глазами. НИЧЕГО НЕ УБИРАЕТ (уборка — `--clean`).
//
// ═══ ЧТО УЖЕ ВЫЯСНЕНО ЖИВЬЁМ (06.08.2026, портал b24-hrbvzq) ═════════════════════════════════
//
// 1. ✅ **`crm.activity.get` ВОЗВРАЩАЕТ `FILES`** — но только когда файл реально прикреплён; у
//    дела без вложения ключа просто нет. Прежний мой вывод «поле не читается ничем» был НЕВЕРЕН
//    и родился из того, что я читал дела, к которым ничего не прикрепилось. Это меняет способ
//    работы: формы прикрепления проверяются программно, звать человека не нужно.
//
// 2. ✅ Прикрепить файл к делу МОЖНО, и форма ровно одна:
//    **`FILES: [{ fileData: [имя, base64] }]`** — из примера на странице `crm.activity.add`.
//
// 3. ❌ Прикрепить файл, УЖЕ ЛЕЖАЩИЙ НА ДИСКЕ, по его идентификатору — не вышло ни одной из
//    ПЯТНАДЦАТИ проверенных форм: `[{id}]`, `["n<id>"]`, `[<id>]`, `[{fileId}]`, `[{ID}]`,
//    `[{id,name}]`, `WEBDAV_ELEMENTS` в тех же видах, `STORAGE_ELEMENT_IDS+STORAGE_TYPE_ID`,
//    и то же самое при СОЗДАНИИ дела, а не в `update`. Пробовались и файл из корня Диска, и файл
//    из служебной папки «Файлы приложений». ⚠ Все они ответили успехом и не прикрепили ничего:
//    `crm.activity.get` после каждой не показывает `FILES`. Сработала только `fileData` (base64).
//    ⇒ Следствие: байты придётся слать заново (`server/utils/diskDownload.ts`), и портал заведёт
//    СВОЮ копию файла в папке «Файлы приложений» — подтверждено чтением Диска.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Что раскладывается в витрине:
//   (а) как сейчас — конфигурируемое дело: подвал с кнопками, файл ссылкой;
//   (б) `todo` + наши блоки + вложение `fileData` — с «Проблемами» И в описании, И блоком;
//   (в) конфигурируемое дело + отдельный комментарий с вложением;
//   (и) ИКОНКИ — шесть конфигурируемых дел с разными `icon`/`logo` (коды взяты С ПОРТАЛА:
//       `crm.timeline.icon.list` / `crm.timeline.logo.list`), чтобы выбрать вид;
//   (ц) ЦВЕТ И ЗАВЕРШЁННОСТЬ — у конфигурируемого дела это теги шапки (`success`/`warning`/
//       `failure`/`secondary`) + `completed`, у `todo` — `colorId` 1–7 + `completed`. Это РАЗНЫЕ
//       механизмы, поэтому показаны оба: выбор носителя определяет и способ покраски.
//
// ⚠ Только тест-портал (`assertTestPortal`), OAuth-контекст приложения.
//
//   pnpm probe:328:show
//   pnpm probe:328:show --clean
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { assertTestPortal } from './lib/testPortalGuard.mjs'
import { liveOauth } from './lib/oauthToken.mjs'

// ⚠ Токен берём через `liveOauth`, а не из файла напрямую: access живёт час, и прогон падал
// `expired_token` на середине, успев наплодить записей на портале.
const { domain: DOMAIN, token: TOKEN } = await liveOauth()
assertTestPortal(`https://${DOMAIN}/`)

const STATE = 'probe-328-showcase.json'
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
const head = m => console.log(`\n\x1b[1m${m}\x1b[0m`)

// Правдоподобные данные одного импорта — сравнивать надо вид, а не «Lorem ipsum».
const SUPPLIER = 'ООО «Белпромснаб»'
const DOC = 'ТН-000451 от 05.08.2026'
const TOTAL = '10 320,00 BYN'
const PROBLEMS = ['Не найдены в каталоге: ZQ-114, ZQ-207', 'Единица «упак.» сопоставлена как «шт»']

const doClean = async () => {
  if (!existsSync(STATE)) return bad(`нет ${STATE} — убирать нечего`)
  const s = JSON.parse(readFileSync(STATE, 'utf8'))
  head('Уборка витрины')
  for (const id of s.activities ?? []) {
    const j = await raw('crm.activity.delete', { id })
    if (j.error) bad(`дело ${id}: ${j.error}`)
    else ok(`дело ${id} удалено`)
  }
  if (s.deal) {
    const j = await raw('crm.deal.delete', { id: s.deal })
    if (j.error) bad(`сделка ${s.deal}: ${j.error}`)
    else ok(`сделка ${s.deal} удалена`)
  }
  for (const id of s.diskFiles ?? []) {
    const j = await raw('disk.file.delete', { id })
    if (j.error) bad(`файл ${id}: ${j.error}`)
    else ok(`файл ${id} удалён`)
  }
  rmSync(STATE)
}

const build = async () => {
  const state = { deal: null, activities: [], diskFiles: [] }
  head('Витрина #328')

  const stamp = Date.now()
  const bytes = Buffer.from(`${DOC}\nПоставщик: ${SUPPLIER}\nВсего к оплате: ${TOTAL}\n`, 'utf8').toString('base64')
  // ⚠ Имя уникально на прогон: Диск отвергает повтор (`DISK_OBJ_22000`), и вторая витрина
  // падала бы на первом же шаге, когда первая ещё висит на портале.
  const fileName = `Накладная ТН-000451__${stamp}.txt`

  const storages = await call('disk.storage.getlist', {})
  const common = (storages ?? []).find(s => s.ENTITY_TYPE === 'common') ?? storages?.[0]
  const up = await call('disk.folder.uploadfile', {
    id: common.ROOT_OBJECT_ID,
    data: { NAME: fileName },
    fileContent: [fileName, bytes]
  })
  state.diskFiles.push(Number(up.ID))
  ok(`архивная копия на Диске: id=${up.ID}`)

  const deal = Number(await call('crm.deal.add', {
    fields: { TITLE: `[ВИТРИНА #328] ${SUPPLIER} · ${DOC}`, OPPORTUNITY: 10320, CURRENCY_ID: 'BYN' }
  }))
  state.deal = deal
  ok(`сделка: id=${deal}`)

  const fileUrl = `/docs/file/${encodeURIComponent(fileName)}?IFRAME=Y&IFRAME_TYPE=SIDE_SLIDER`
  const problemsText = PROBLEMS.map((p, i) => `${i + 1}. ${p}`).join('\n')
  const bodyBlocks = () => ({
    supplier: { type: 'withTitle', properties: { title: 'Поставщик', block: { type: 'text', properties: { value: SUPPLIER } } } },
    doc: { type: 'withTitle', properties: { title: 'Документ', block: { type: 'text', properties: { value: DOC } } } },
    sum: { type: 'withTitle', properties: { title: 'Сумма', block: { type: 'text', properties: { value: TOTAL, bold: true } } } },
    lines: { type: 'withTitle', properties: { title: 'Позиции', block: { type: 'text', properties: { value: '7 строк, подобрано 5' } } } },
    problems: { type: 'withTitle', properties: { title: `Проблемы (${PROBLEMS.length})`, block: { type: 'text', properties: { value: problemsText, multiline: true } } } }
  })

  /** Конфигурируемое дело — наш нынешний носитель. Цвет здесь это ТЕГ шапки, не `colorId`. */
  const conf = async (label, { icon, logo, tag, completed = 'Y', footer = true }) => {
    const r = await call('crm.activity.configurable.add', {
      ownerTypeId: 2,
      ownerId: deal,
      fields: { typeId: 'CONFIGURABLE', completed, responsibleId: 1 },
      layout: {
        icon: { code: icon },
        header: { title: label, ...(tag ? { tags: { state: { title: tag.title, type: tag.type } } } : {}) },
        body: { logo: { code: logo }, blocks: bodyBlocks() },
        ...(footer
          ? {
              footer: {
                buttons: {
                  open: { title: 'Открыть', type: 'primary', action: { type: 'redirect', uri: `/crm/deal/details/${deal}/` } },
                  source: { title: 'Исходный файл', type: 'secondary', action: { type: 'redirect', uri: fileUrl } }
                }
              }
            }
          : {})
      }
    })
    const id = Number(r.activity.id)
    state.activities.push(id)
    return id
  }

  /** Универсальное дело — `colorId` красит полосу, завершение отдельным `update`. */
  const todo = async (title, { colorId, withFile = false, completed = false } = {}) => {
    const t = await call('crm.activity.todo.add', {
      ownerTypeId: 2,
      ownerId: deal,
      deadline: new Date(Date.now() + 864e5).toISOString(),
      title,
      // ⚠ Проблемы ИМЕННО в описании (просьба владельца): в блоках их видно, только если
      // раскрыть текст, а описание читается сразу под заголовком.
      description: `${SUPPLIER} · ${DOC} · ${TOTAL}\n\nПроблемы (${PROBLEMS.length}):\n${problemsText}`,
      responsibleId: 1,
      ...(colorId ? { colorId: String(colorId) } : {})
    })
    const id = Number(t.id)
    state.activities.push(id)
    if (withFile) {
      // ⚠ ЕДИНСТВЕННАЯ работающая форма — base64: пятнадцать форм «по id файла на Диске» портал
      // принимает без ошибки и не прикрепляет ничего.
      await raw('crm.activity.update', { id, fields: { FILES: [{ fileData: [fileName, bytes] }] } })
    }
    await raw('crm.activity.layout.blocks.set', {
      entityTypeId: 2,
      entityId: deal,
      activityId: id,
      layout: {
        blocks: {
          ...bodyBlocks(),
          open: { type: 'link', properties: { text: 'Открыть сделку', bold: true, action: { type: 'redirect', uri: `/crm/deal/details/${deal}/` } } }
        }
      }
    })
    if (completed) await raw('crm.activity.update', { id, fields: { COMPLETED: 'Y' } })
    // Вложение проверяем ЧТЕНИЕМ, а не по ответу `update`: он успешен и когда ничего не приложилось.
    const back = await raw('crm.activity.get', { id })
    return { id, files: back.result?.FILES ?? null }
  }

  head('Три варианта подачи')
  ok(`(а) как сейчас → ${await conf(`(а) КАК СЕЙЧАС · ${TOTAL}`, { icon: 'sum', logo: 'document' })}`)
  const b = await todo(`(б) TODO + вложение + проблемы в описании · ${TOTAL}`, { withFile: true })
  ok(`(б) todo с вложением → ${b.id} · FILES=${b.files ? 'ПРИКРЕПЛЁН' : 'НЕТ'}`)
  const cId = await conf(`(в) КОНФИГ + комментарий с вложением · ${TOTAL}`, { icon: 'sum', logo: 'document' })
  const cmt = await call('crm.timeline.comment.add', {
    fields: { ENTITY_ID: deal, ENTITY_TYPE: 'deal', COMMENT: `Исходный документ импорта: ${DOC}`, FILES: [[fileName, bytes]] }
  })
  ok(`(в) дело ${cId} + комментарий ${cmt} с вложением`)

  head('Иконки и логотипы — коды прочитаны с портала')
  for (const [icon, logo, note] of [
    ['store', 'shop', 'склад/товары'],
    ['document', 'document', 'документ'],
    ['wallet', 'bank-card', 'деньги'],
    ['pipeline', 'list-check', 'конвейер/список'],
    ['ai-process', 'ai-copilot', 'ИИ-обработка'],
    ['complete', 'list-check', 'готово']
  ]) {
    ok(`(и) icon=${icon} logo=${logo} — ${note} → ${await conf(`(и) icon=${icon} · logo=${logo} — ${note}`, { icon, logo })}`)
  }

  head('Цвет и завершённость — механизмы у двух носителей РАЗНЫЕ')
  for (const [type, title] of [['success', 'ЗЕЛЁНЫЙ'], ['warning', 'ЖЁЛТЫЙ'], ['failure', 'КРАСНЫЙ'], ['secondary', 'СЕРЫЙ']]) {
    ok(`(ц) конфиг, тег ${type} → ${await conf(`(ц) КОНФИГ · тег ${type}`, { icon: 'sum', logo: 'document', tag: { title, type } })}`)
  }
  ok(`(ц) конфиг НЕ завершено → ${await conf('(ц) КОНФИГ · НЕ завершено (completed=N)', { icon: 'attention', logo: 'document', completed: 'N', tag: { title: 'ЕСТЬ ПРОБЛЕМЫ', type: 'warning' } })}`)
  for (const colorId of [1, 2, 3, 5, 7]) {
    ok(`(ц) todo colorId=${colorId} → ${(await todo(`(ц) TODO · colorId=${colorId}`, { colorId })).id}`)
  }
  ok(`(ц) todo завершено → ${(await todo('(ц) TODO · завершено (completed=Y)', { colorId: 2, completed: true })).id}`)

  writeFileSync(STATE, JSON.stringify(state, null, 2))
  head('Смотреть здесь')
  console.log(`  https://${DOMAIN}/crm/deal/details/${deal}/`)
  console.log('\n  Убрать потом: pnpm probe:328:show --clean')
}

try {
  if (clean) await doClean()
  else await build()
} catch (e) {
  bad(String(e?.message ?? e))
  process.exitCode = 1
}
