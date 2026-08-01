// System prompt for the extraction model (OpenAI-compatible chat: DeepSeek / BitrixGPT). It is a
// PURE extractor: it reads the document text and returns ONE JSON object matching
// ExtractedDocument — no Bitrix24 access, no prose. Encodes the multilingual tax-id
// and VAT rules from docs/PROCESS.md §5 «Распознавание нейросетью» и §9 «Языки документов». Pure string builder (tested).
//
// NB: the instruction text is Russian on purpose — documents are ru/be/kk and the
// model reasons about them in Russian; only this comment/JSDoc is English.
//
// ⚠ THIS TEXT IS MEASURED, NOT DRAFTED. It was A/B'd against 34 real invoices (#336): the
// per-row arithmetic self-check in rule 1 and the standalone vatRate rule are what moved the
// numbers, and BOTH carry an explicit «does not affect priceIncludesVat» disclaimer because
// without it the model drifted toward `priceIncludesVat: true` — the unsafe direction, since
// Σ price×qty is indistinguishable from a net document's «Итого» and trusting it drops the VAT
// (see app/utils/pricing.ts). Measured over the 34 documents, old → new: flag=true 16 → 8,
// «corrected by the printed total» 14 → 7, mismatches 3 → 2.
// The rule NUMBERING is deliberately left as it came out of that measurement (1,2,3,8,7,4,5,6) —
// tidying it edits the prompt, and any prompt edit invalidates the numbers above. Re-run the A/B
// before "just renumbering".

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
   СВЕРЬ КАЖДУЮ СТРОКУ АРИФМЕТИКОЙ: quantity × price обязано давать напечатанную В ЭТОЙ ЖЕ СТРОКЕ сумму
   (ту, что БЕЗ НДС, если в строке есть и «Сумма», и «Всего с НДС»). Не сошлось — значит из строки взято
   не то число, ищи другую пару. В строке часто стоит НЕСКОЛЬКО ценовых колонок (цена за единицу измерения
   и цена за упаковку/место) и НЕСКОЛЬКО числовых (количество, объём, вес, кол-во мест). Бери ту цену и то
   количество, произведение которых равно этой сумме. Прочие числа строки — не цена и не количество: в
   items их не клади и в name не вписывай.
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
5. Артикул поставщика (article) — код/артикул рядом с наименованием, если есть. Единицу (unit) — как напечатано
   («шт», «кг», «дана»). Сохраняй казахские буквы (ә, ғ, қ, ң, ө, ұ, ү, һ, і) без изменений.
6. Валюта — код ISO 4217 (BYN, RUB, KZT, USD). Не уверен — пропусти currency.

ПРИМЕР корректного ответа:
${EXAMPLE}`
}
