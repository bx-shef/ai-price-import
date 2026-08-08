// System prompt for the extraction model (OpenAI-compatible chat: DeepSeek / BitrixGPT). It is a
// PURE extractor: it reads the document text and returns ONE JSON object matching
// ExtractedDocument — no Bitrix24 access, no prose. Encodes the multilingual tax-id
// and VAT rules from docs/PROCESS.md §5 «Распознавание нейросетью» и §9 «Языки документов». Pure string builder (tested).
//
// NB: the instruction text is Russian on purpose — documents are ru/be/kk and the
// model reasons about them in Russian; only this comment/JSDoc is English.
//
// ⚠ ПРАВИЛО 5 (АРТИКУЛ) ПЕРЕЗАМЕРЕНО 2026-08-05 на корпусе владельца — 31 реальный документ,
// 472 позиции, провайдер bitrixgpt. Два разных замера, оба нужны:
//
// 1) АРТИКУЛ (парно, свой прогон — штатный набор его не меряет вовсе):
//      штрихкоды в поле article   35 → 0    ← ради этого правка и делалась
//      верных артикулов          ~250 → 263
//      документов лучше 3 · хуже 0 · без изменений 27
//    Прежняя редакция складывала в `article` ШТРИХКОДЫ EAN-13: в счёте `Счет 3886 Уручье` 35 из 42
//    «артикулов» оказались ими (префикс 481 — Беларусь), причём у первой позиции настоящий артикул
//    `B-WS3595` напечатан рядом и был проигнорирован.
//    ⚠ УРОК ПРО МЕТРИКУ, а не про промпт: сводная «доля позиций с артикулом» ОБМАНЧИВА — она
//    считала штрихкоды успехом, и по ней новая редакция выглядела ХУЖЕ (285 → 263). Проверка
//    «значение есть в тексте документа» тоже не спасает: штрихкод там напечатан. Считать надо, ЧТО
//    попало в поле, а не сколько полей заполнено.
//
// 2) ДЕНЬГИ (`pnpm ab:prompt --dir <корпус> --runs 2`, 58 прогонов на сторону) — проверка, что
//    правка не сломала работавшее:
//      итог не сошёлся             0 → 0    ← деньги верны в КАЖДОМ прогоне обеих сторон
//      взяли слово модели (риск)   0 → 0
//      с НДС прочитан как без НДС  0 → 0
//      флаг правился по итогу     28 → 30   ← возможная плата
//      flag=true                  32 → 36   ← возможная плата
//      парно по документам: лучше 0 · хуже 0 · без изменений 29 · McNemar p = 1.000
//    ⚠ Плата названа, но НЕ ДОКАЗАНА: два прогона, разброс модели велик, а 28→30 на 58 прогонах от
//    шума неотличимо. Направление при этом то же, о котором предупреждает абзац ниже (крен в
//    «цены с НДС»), поэтому считаем её вероятной, а не мнимой. `reconcilePricing` этот крен
//    исправляет по печатному итогу — в замере ни один документ не разошёлся по деньгам.
//
// ⚠ THIS TEXT IS MEASURED, NOT DRAFTED — and the measurement is honest about what it does not
// show. `pnpm ab:prompt --dir <корпус> --runs 2` (scripts/ab-prompt.mjs) A/B'd it against
// origin/main over 33 distinct real documents OUTSIDE the repo, 2 runs per side, 66 runs each
// (#336/#337) — NOT the bare `pnpm ab:prompt`, which since #342 runs the small committed corpus:
//
//   итог не сошёлся      7 → 4   ← парно по документам: лучше на 2, хуже на 0, McNemar p = 0.500
//   флаг правился по итогу 23 → 34  ← ХУЖЕ
//   flag=true            27 → 37  ← ХУЖЕ
//   взяли слово модели    0 → 1   ← ХУЖЕ (один прогон одного документа)
//   с НДС прочитан как без НДС  0 → 0
//
// So: the row-arithmetic rule never made a document worse and fixed two, but with only two
// discordant pairs that is NOT statistically significant. The cost is real and measured — the
// model leans further toward `priceIncludesVat: true`, which `reconcilePricing` then corrects
// from the printed total (money stayed right in every run; the lone «взяли слово модели» is a
// document where `true` is plausibly correct and unverifiable by arithmetic). Both new rules
// carry an explicit «does not affect priceIncludesVat» disclaimer; it reduces that lean but does
// not remove it. Do not quote the improvement without the cost.
//
// Rule NUMBERING is 1,2,3,8,7,4,5,6: the stray `7` predates #336, and the new rule was appended
// as `8` rather than renumbering, because renumbering edits the text and any text edit
// invalidates the numbers above. Re-measure before changing a word — including "just tidying".
//
// TWO DIFFERENT RUNS, do not confuse them (#342):
//   pnpm ab:prompt                       — SMOKE TEST on the small anonymised corpus in the
//                                          repo (corpus/prompt-ab). Runs in one line, needs no
//                                          client documents, and can only tell you the prompt did
//                                          not break on the covered classes. It CANNOT justify
//                                          editing the numbers above: a corpus this small makes McNemar
//                                          insignificant by construction, and whole classes are
//                                          missing (no total at all, kk/be, OCR — see its README).
//   pnpm ab:prompt --dir <корпус> --runs 2 — the REAL measurement, on a corpus of comparable size
//                                          OUTSIDE the repository. Only this one may replace the
//                                          numbers above, and it must replace ALL of them at once.

/** The strict output contract shown to the agent (mirrors app/types/document.ts). */
const OUTPUT_SCHEMA = `{
  "documentType": "накладная" | "счёт" | "КП" | "спецификация" | "прайс" | "" ,
  "currency": "ISO 4217, напр. BYN, RUB, KZT, USD (3 буквы) или пропусти",
  "priceIncludesVat": false | true,
  "total": "число «Всего к оплате»/итоговая сумма С НДС, как напечатано, или пропусти",
  "supplier": { "name": "как в документе", "taxId": "только цифры", "taxIdKind": "INN|UNP|BIN|IIN" },
  "items": [
    { "name": "наименование", "article": "артикул поставщика", "quantity": 0, "unit": "шт", "price": 0, "vatRate": 20 }
  ]
}`

// Example mirrors the common РБ/РФ invoice: NET unit prices + VAT added on top → priceIncludesVat=false,
// total = «Всего к оплате» (gross). (10×5.00 = 50.00 net; +20% = 60.00 gross.)
const EXAMPLE = `{"documentType":"счёт","currency":"BYN","priceIncludesVat":false,"total":60.00,"supplier":{"name":"ООО \\"Ромашка\\"","taxId":"190000000","taxIdKind":"UNP"},"items":[{"name":"Болт М6","article":"BM6-01","quantity":10,"unit":"шт","price":5.00,"vatRate":20}]}`

/**
 * Build the extraction system prompt. Parameterless for the MVP — the agent only
 * extracts what is printed; portal-specific mapping (article field, unit dictionary,
 * routing) is applied deterministically later in crm-sync.
 */
export function buildExtractionPrompt(): string {
  return `Ты — извлекатель данных из документа с табличной частью (накладная, счёт, КП, прайс, спецификация).
Язык документа — русский, белорусский или казахский. Верни РОВНО ОДИН JSON-объект по схеме ниже и НИЧЕГО больше:
без пояснений, без markdown, без \`\`\`. Не выдумывай значения — если поля нет в документе, пропусти его.

СХЕМА:
${OUTPUT_SCHEMA}

ПРАВИЛА:
1. Табличная часть 1-в-1: каждая строка товара — отдельный элемент items. Ничего не объединяй и не пропускай.
   Цену и количество бери как напечатано (десятичный разделитель — точка или запятая, разряды — пробелы).
   СВЕРЬ КАЖДУЮ СТРОКУ АРИФМЕТИКОЙ — это способ ВЫБРАТЬ нужные числа, когда их в строке несколько:
   quantity × price должно сойтись с напечатанной В ЭТОЙ ЖЕ СТРОКЕ суммой — той, что в одной «налоговой
   плоскости» с ценой (цена без НДС ↔ «Сумма»/«Стоимость»; цена с НДС ↔ «Всего с НДС»/«Сумма с НДС»).
   В строке часто стоит НЕСКОЛЬКО ценовых колонок (цена за единицу измерения и цена за упаковку/место)
   и НЕСКОЛЬКО числовых (количество, объём, вес, кол-во мест). Бери ту пару, произведение которой даёт
   эту сумму. Прочие числа строки — не цена и не количество: в items их не клади и в name не вписывай.
   • Разошлось В РАЗЫ ⇒ взята не та пара, ищи другую.
   • Разошлось на копейки или доли процента ⇒ ЭТО НОРМА: цена за единицу напечатана округлённой
     (тариф, цена за метр/кг/литр). Оставь как напечатано.
   • Пары, дающей сумму, в строке нет, или суммы нет вовсе (прайс, КП без итогов) ⇒ бери цену и
     количество как напечатано.
   ⚠ НИЧЕГО НЕ ПОДГОНЯЙ: не вычисляй цену из суммы делением и не подменяй количество, чтобы «сошлось».
   Записать число, которого в документе нет, — хуже, чем оставить расхождение: расхождение мы поймаем сами.
   ⚠ Эта сверка — ТОЛЬКО про выбор пары чисел внутри строки. На priceIncludesVat (правило 3) она не влияет:
   совпадение quantity × price с «Суммой» строки НЕ означает, что цена с НДС.
2. Налоговый идентификатор поставщика (метка зависит от страны/языка), число — ТОЛЬКО цифры:
   • Россия — «ИНН» (10 цифр юр. / 12 физ.) → taxIdKind "INN".
   • Беларусь — «УНП» (9 цифр; метка одна на рус/бел) → "UNP".
   • Казахстан — «БИН»/каз. «БСН» (юр., 12 цифр) → "BIN"; «ИИН»/каз. «ЖСН» (физ., 12 цифр) → "IIN".
   Понимай метку на языке документа (напр. каз. «сатушының БСН-і»). Не распознал — пропусти supplier.taxId.
3. НДС: определи ОДНО значение priceIncludesVat на весь документ ПО СТРУКТУРЕ ИТОГОВ, а не по картинке:
   • цены/суммы строк и «Итого» показаны БЕЗ НДС, а НДС идёт отдельной строкой и прибавляется сверху
     (Итого → НДС → «Всего к оплате» = Итого + НДС) ⇒ priceIncludesVat = false; ← ЧАСТЫЙ случай (счёт РБ/РФ);
   • цена уже с НДС («в т.ч. НДС», «цена с НДС», «включая НДС») ИЛИ «Всего» равно сумме строк без отдельного
     прибавления НДС ⇒ priceIncludesVat = true;
   • НДС в документе нет ⇒ priceIncludesVat = false.
   Проверь себя арифметикой: если Цена×Кол-во по строкам даёт «Итого» (без НДС), а «Всего к оплате» больше на
   сумму НДС — это priceIncludesVat = false. Ставку каждой позиции (vatRate, напр. 0/10/20) бери как напечатано.
8. Ставка НДС строки (vatRate) — СТРОГО как напечатано: из колонки ставки этой строки, а если такой колонки
   нет — из итогов документа. «НДС 0%», «без НДС», «не облагается» ⇒ vatRate = 0. НЕ подставляй «обычную
   ставку страны поставщика»: экспортные счета и освобождённые товары идут с нулевой ставкой, и 20 вместо
   0 — ошибка. Это ставка ОТДЕЛЬНОЙ СТРОКИ; на общий флаг priceIncludesVat (правило 3) она не влияет.
7. Итоговая сумма (total): ФИНАЛЬНАЯ сумма К ОПЛАТЕ, С НДС (gross) — строка «Всего к оплате» / «Итого к
   оплате» / «на сумму …». Это НЕ «Итого» и НЕ «Итого без НДС» (промежуточная сумма БЕЗ НДС) — если в
   документе есть и «Итого» (без НДС), и «Всего к оплате» (с НДС), бери большее — «Всего к оплате». Бери
   как напечатано (разряды — пробелы, десятичный — точка/запятая). Нет строки к оплате — пропусти.
4. Тип документа (documentType) классифицируй ПО СМЫСЛУ, а не по букве: накладная / счёт / КП / спецификация /
   прайс. Устойчиво к языку (бел. «рахунак» = счёт; каз. «жүкқұжат» = накладная; каз. «коммерциялық ұсыныс» = КП).
5. Артикул поставщика (article) — код товара У ПОСТАВЩИКА. Ищи его в колонке «Артикул», «Арт.», «Код»,
   «Каталожный номер», «SKU». Если отдельной колонки НЕТ, а код напечатан В НАЧАЛЕ наименования
   («0070.1232.02 абр блок …»), вынеси код в article, а name оставь КАК НАПЕЧАТАНО — вместе с кодом.
   НЕ бери в article порядковый номер строки, номер документа, ШТРИХКОД, код единицы измерения и код
   страны. Нет кода — пропусти article. Единицу (unit) — как напечатано
   («шт», «кг», «дана»). Сохраняй казахские буквы (ә, ғ, қ, ң, ө, ұ, ү, һ, і) без изменений.
6. Валюта — код ISO 4217 (BYN, RUB, KZT, USD). Не уверен — пропусти currency.

ПРИМЕР корректного ответа:
${EXAMPLE}`
}
