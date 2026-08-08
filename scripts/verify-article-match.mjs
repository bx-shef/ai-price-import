// Живая приёмка подбора товара ПО АРТИКУЛУ (#383) — матрица краевых случаев на тест-портале.
//
// ⚠ Зачем отдельная проверка. Неверный подбор НЕ падает и НЕ пишет предупреждение — он молча
// ставит в сделку клиента ЧУЖОЙ товар. Такую ошибку находит бухгалтер клиента, а не мы, и находит
// через месяц. Обычный живой прогон (`pnpm live:crm`) идёт по счастливому пути: артикул есть,
// товар один, всё совпало. Здесь нарочно устраиваются случаи, где легко подобрать не то.
//
// ⚠ Проверяется НАСТОЯЩАЯ `findProduct` из `server/utils/productLookup.ts`, а не переписанный в
// скрипте запрос. Смысл именно в этом: комментарии в том файле — сегодня единственный источник
// правды по REST-фактам каталога, и они написаны «по контракту документации». Скрипт, повторяющий
// запрос своими руками, проверял бы догадку саму на себе.
//
//   pnpm verify:article          # завести зонды, прогнать матрицу, убрать за собой
//   pnpm verify:article --keep   # оставить зонды на портале (посмотреть глазами)
//
// ⚠ ТОЛЬКО тест-портал: скрипт заводит и удаляет товары. Гард `assertTestPortal`.
// ⚠ Уборка идёт в `finally` — упавшее утверждение не должно оставлять зонды в каталоге: следующий
//   прогон нашёл бы их как «уже есть» и проверял бы мусор прошлой попытки.

import { makeCall, readHook } from './lib/testPortal.mjs'
import { assertTestPortal } from './lib/testPortalGuard.mjs'
import { findProduct } from '../server/utils/productLookup.ts'

const WEBHOOK = readHook('.env.b24test')
assertTestPortal(WEBHOOK)
const call = makeCall(WEBHOOK)
const keep = process.argv.includes('--keep')

/** Префикс внешнего кода зондов: по нему же идёт уборка. */
const PROBE = 'AIPI_ARTPROBE_'

/**
 * Зонды каталога. Каждый отвечает на один вопрос матрицы #383.
 *
 * ⚠ Артикулы нарочно непохожи на реальные и несут общий префикс: зонд, случайно совпавший с живым
 * товаром портала, дал бы ложно-зелёный результат («нашлось» — но не наше).
 */
const PROBES = [
  { key: 'inactive', name: '[PROBE] неактивный', article: 'ZQ-INACT-1', active: 'N' },
  { key: 'long', name: '[PROBE] длинный артикул', article: 'ZQ-50', active: 'Y' },
  { key: 'cyr', name: '[PROBE] кириллица в артикуле', article: 'ZQ-СYR-1', active: 'Y' },
  { key: 'multi', name: '[PROBE] несколько артикулов через запятую', article: 'ZQ-M1,ZQ-M2', active: 'Y' },
  { key: 'lines', name: '[PROBE] несколько артикулов строками', article: 'ZQ-L1\r\nZQ-L2', active: 'Y' },
  { key: 'xml', name: '[PROBE] только внешний код', article: '', active: 'Y', xmlOnly: 'ZQ-XMLONLY' },
  // Пара, различающаяся ТОЛЬКО регистром внешнего кода. Живая проба 06.08.2026: портал вернул ОБА
  // товара на каждый из четырёх запросов (верхний, нижний, вперемешку, с префиксом `=`).
  { key: 'caseUp', name: '[PROBE] регистр: верхний', article: '', active: 'Y', xmlOnly: 'ZQ-CASE-DUP' },
  { key: 'caseLow', name: '[PROBE] регистр: нижний', article: '', active: 'Y', xmlOnly: 'zq-case-dup' }
]

/** Инфоблок товаров + числовой id свойства «Артикул» (его заводит `pnpm seed:b24`). */
async function catalogContext() {
  const { catalogs } = await call('catalog.catalog.list', { select: ['id', 'iblockId', 'productIblockId'] })
  const list = catalogs ?? []
  const iblockId = list.find(c => c.productIblockId)?.productIblockId ?? list[0]?.iblockId
  if (!iblockId) throw new Error('на портале нет каталога товаров')
  const { productProperties } = await call('catalog.productProperty.list', {
    filter: { iblockId }, select: ['id', 'code']
  })
  const prop = (productProperties ?? []).find(p => p.code === 'ARTICLE')
  if (!prop) throw new Error('свойства «Артикул» нет в каталоге — сначала `pnpm seed:b24`')
  return { iblockId, propertyId: prop.id }
}

const xmlIdFor = key => `${PROBE}${key.toUpperCase()}`

async function createProbes(iblockId, propertyId) {
  const made = []
  for (const p of PROBES) {
    const fields = {
      iblockId,
      name: p.name,
      xmlId: p.xmlOnly ?? xmlIdFor(p.key),
      active: p.active
    }
    if (p.article) fields[`property${propertyId}`] = p.article
    const { element } = await call('catalog.product.add', { fields })
    made.push({ ...p, id: Number(element.id) })
  }
  return made
}

async function removeProbes(iblockId) {
  let removed = 0
  // Уборка по ВНЕШНЕМУ КОДУ, а не по сохранённым id: упавший на середине прогон оставил бы часть
  // зондов, о которых текущий процесс ничего не знает.
  for (const p of PROBES) {
    const code = p.xmlOnly ?? xmlIdFor(p.key)
    // Неактивный товар тоже надо убрать, поэтому фильтр без `active`.
    const { products } = await call('catalog.product.list', { filter: { iblockId, xmlId: code }, select: ['id', 'iblockId'] })
    for (const row of products ?? []) {
      await call('catalog.product.delete', { id: row.id })
      removed++
    }
  }
  return removed
}

/** Настройка портала под конкретную форму свойства. */
const mappingFor = (propertyId, kind, delimiter) => ({
  article: { field: String(propertyId), scope: 'product', kind, delimiter },
  product: { by: 'article', onMissing: 'freeform' }
})

let IBLOCKS = { offer: [], product: [] }
const lookup = (article, mapping) => findProduct({ name: 'зонд', article, price: 1, quantity: 1 }, mapping, call, IBLOCKS)

const results = []
/** Утверждение с человеческой формулировкой: печатается и зелёное, и красное. */
function check(title, ok, detail) {
  results.push({ title, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${title}${detail ? ` — ${detail}` : ''}`)
}

try {
  const { iblockId, propertyId } = await catalogContext()
  console.log(`инфоблок товаров ${iblockId}, свойство артикула PROPERTY_${propertyId}\n`)

  // Убираем хвосты прошлого прогона ДО посева: иначе `catalog.product.add` заведёт второй товар с тем
  // же внешним кодом, и `minId` вернёт прошлый — проверка стала бы измерять историю.
  const stale = await removeProbes(iblockId)
  if (stale) console.log(`· убраны ${stale} зонда(ов) прошлого прогона\n`)

  // Уборка идёт по внешнему коду, а не по этому списку, поэтому наружу его выносить незачем.
  IBLOCKS = { offer: [], product: [iblockId] }
  const made = await createProbes(iblockId, propertyId)
  const byKey = Object.fromEntries(made.map(p => [p.key, p]))
  console.log(`заведено зондов: ${made.length}\n`)

  const strMap = mappingFor(propertyId, 'string', ',')
  const txtMap = mappingFor(propertyId, 'text')

  // 1. Неактивный товар не подбирается. Фильтр `ACTIVE:'Y'` до сих пор держался на контракте из
  //    документации — тот самый комментарий «live-verify before relying on them».
  check(
    'неактивный товар с подходящим артикулом НЕ подбирается',
    (await lookup('ZQ-INACT-1', strMap)) === null,
    `товар ${byKey.inactive.id} заведён с ACTIVE:'N'`
  )

  // 2. Подстрочный ложняк. Серверный `%LIKE` вернёт «ZQ-50» на запрос «ZQ-5»; отбраковка наша.
  check(
    'артикул-подстрока не подбирает чужой товар (ZQ-5 против ZQ-50)',
    (await lookup('ZQ-5', strMap)) === null
  )
  check(
    'точный артикул при этом находится (ZQ-50)',
    (await lookup('ZQ-50', strMap)) === byKey.long.id
  )

  // 3. Омоглифы. ⚠ Ожидание тут — НЕ «работает», а «известное ограничение», и утверждается
  //    фактическое поведение, чтобы его изменение было ЗАМЕЧЕНО.
  //
  //    ЧТО ИМЕННО НЕ НАХОДИТСЯ. В каталоге лежит артикул `ZQ-СYR-1` с КИРИЛЛИЧЕСКОЙ `С`
  //    (U+0421). Ищем `ZQ-CYR-1` с ЛАТИНСКОЙ `C` (U+0043) — то есть ТОТ ЖЕ артикул в другом
  //    написании. Портал отвечает пусто, строка уходит в сделку свободной позицией без привязки
  //    к каталогу. Случай не выдуманный: в документе поставщика код набран латиницей, а в
  //    каталоге кто-то завёл его с кириллической буквой (или наоборот) — на глаз одно и то же,
  //    для базы разные байты.
  //
  //    ПОЧЕМУ НАША СВЁРТКА НЕ СПАСАЕТ. `foldHomoglyphs` (`app/utils/homoglyph.ts`) приводит
  //    кир. `с` → лат. `c`, но применяется ПОСЛЕ запроса — к строкам, которые портал уже вернул.
  //    Здесь он не возвращает ничего, и сворачивать нечего.
  //
  //    ПОЧЕМУ НЕ ПОЧИНЕНО. Единственный способ — перебор написаний: на каждую позицию документа
  //    слать не один запрос, а по одному на каждый вариант (`ZQ-CYR-1` латиницей, `ZQ-СYR-1`
  //    кириллицей, смешанные). У артикула из N неоднозначных букв вариантов до 2^N, то есть
  //    накладная на 50 строк упирается в лимит запросов к порталу ради случая, который на живых
  //    документах пока не встречался. Заводить это стоит по первому реальному обращению, а не
  //    заранее.
  const cyrSelf = await lookup('ZQ-СYR-1', strMap)
  const cyrLatin = await lookup('ZQ-CYR-1', strMap)
  check('артикул с кириллической С находится сам собой', cyrSelf === byKey.cyr.id)
  check(
    'ОГРАНИЧЕНИЕ: латинское написание того же артикула НЕ находится',
    cyrLatin === null,
    'байтовый LIKE не возвращает строку, свёртка спасает только уже возвращённые'
  )

  // 4. Несколько артикулов в одном значении — обе формы поля.
  check('строковое свойство с разделителем: находится первый (ZQ-M1)', (await lookup('ZQ-M1', strMap)) === byKey.multi.id)
  check('строковое свойство с разделителем: находится второй (ZQ-M2)', (await lookup('ZQ-M2', strMap)) === byKey.multi.id)
  check('текстовое свойство: находится артикул с первой строки (ZQ-L1)', (await lookup('ZQ-L1', txtMap)) === byKey.lines.id)
  check(
    'текстовое свойство: находится артикул со второй строки (ZQ-L2, перенос CRLF)',
    (await lookup('ZQ-L2', txtMap)) === byKey.lines.id,
    'значение вставлено с \\r\\n — так его отдаёт копипаст из Windows'
  )

  // 5. Внешний код — вторая стратегия, работает БЕЗ настроенного свойства. Это и есть
  //    дистрибьюторский случай из #383: каталог ключуется XML_ID, свойство не выбрано вовсе.
  const noProp = { article: { field: '', scope: 'product', kind: 'text' }, product: { by: 'article', onMissing: 'freeform' } }
  check(
    'внешний код находит товар БЕЗ настроенного свойства артикула',
    (await lookup('ZQ-XMLONLY', noProp)) === byKey.xml.id
  )
  // ⚠ ЖИВАЯ НАХОДКА 2026-08-06, против написанного в коде. `productLookup.findProductByXmlId`
  //    называл этот фильтр «Exact match» — портал сравнивает БЕЗ УЧЁТА РЕГИСТРА. Для подбора это
  //    скорее хорошо (поставщик печатает `zq-1`, в каталоге `ZQ-1`), но утверждать надо то, что
  //    есть: следующий читатель кода строил бы на «точном совпадении» вывод о двух товарах,
  //    различающихся только регистром внешнего кода, — а они для фильтра ОДИН и тот же, и `minId`
  //    выберет из них произвольный.
  check(
    'внешний код находится и в другом регистре (портал сравнивает без учёта регистра)',
    (await lookup('zq-xmlonly', noProp)) === byKey.xml.id,
    'комментарий в findProductByXmlId обещал точное совпадение — исправлено по факту'
  )

  // 5б. Два товара, различающиеся ТОЛЬКО регистром внешнего кода. Раньше `minId` молча брал
  //     меньший id: документ с кодом в нижнем регистре получал в сделку товар с верхним — не «не
  //     нашли», а «нашли не тот». Теперь такой случай честно считается неподобранным.
  check(
    'внешний код неоднозначен по регистру (ZQ-CASE-DUP и zq-case-dup) → «не подобрано», а не произвольный',
    (await lookup('zq-case-dup', noProp)) === null,
    `в каталоге оба: ${byKey.caseUp.id} и ${byKey.caseLow.id}`
  )

  // 6. Ничего не совпало → null, а не произвольный товар. Ровно этим кончается «портал молча
  //    игнорирует неизвестный фильтр и отдаёт весь каталог».
  check('несуществующий артикул → подбора нет', (await lookup('ZQ-НЕТ-ТАКОГО-АРТИКУЛА', strMap)) === null)
  check(
    'НЕСУЩЕСТВУЮЩЕЕ свойство в настройке → подбора нет, а не первый товар каталога',
    (await lookup('ZQ-50', mappingFor(999999, 'string', ','))) === null,
    'портал такой фильтр игнорирует и отдаёт весь список — спасает сверка на клиенте'
  )
} finally {
  if (keep) {
    console.log('\n· зонды оставлены на портале (--keep); убрать: повторный прогон без флага')
  } else {
    const n = await removeProbes(IBLOCKS.product[0] ?? (await catalogContext()).iblockId)
    console.log(`\n· убрано зондов: ${n}`)
  }
}

const failed = results.filter(r => !r.ok)
console.log(`\n${failed.length ? '❌' : '✅'} утверждений: ${results.length}, не выполнено: ${failed.length}`)
if (failed.length) {
  for (const f of failed) console.log(`  ✗ ${f.title}`)
  process.exit(1)
}
