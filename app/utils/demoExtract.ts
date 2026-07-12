// Deterministic demo extractor for the public landing tryout. NO LLM, NO Bitrix24.
// Parses a semi-structured text document (КП / счёт / ТТН) in Russian / Belarusian /
// Kazakh into a small result: doc type, supplier + tax id, goods table, totals.
// Pure + unit-tested. Real arbitrary-PDF extraction (agent) is the product path; this
// keeps the public demo free, safe and dependency-free. When an LLM key + prod
// extraction tools land, the demo endpoint can swap this for `runAgent`.

/** Cap input so a pasted mega-file can't wedge the parser (DoS guard). */
export const MAX_DEMO_CHARS = 200_000
/** Cap rows we surface in the demo. */
export const MAX_DEMO_ITEMS = 500

export type DemoDocType = 'quote' | 'invoice' | 'waybill' | 'unknown'
export type DemoLang = 'ru' | 'be' | 'kk' | 'unknown'
export type TaxIdKind = 'УНП' | 'ИНН' | 'БИН' | 'БСН' | 'ИИН' | 'ЖСН'

export interface DemoItem {
  name: string
  article?: string
  quantity?: number
  unit?: string
  price?: number
  sum?: number
}

export interface DemoResult {
  docType: DemoDocType
  docTypeLabel: string
  number?: string
  date?: string
  supplier?: { name?: string, taxId?: string, taxIdKind?: TaxIdKind }
  items: DemoItem[]
  totals: { sum?: number, vat?: number, total?: number }
  /** Display currency symbol for the amounts (₽ / Br / ₸ / …), when recognised. */
  currency?: string
  language: DemoLang
  warnings: string[]
}

const CURRENCY_SYMBOL: Record<string, string> = {
  RUB: '₽', BYN: 'Br', KZT: '₸', USD: '$', EUR: '€', UAH: '₴'
}

/** ISO currency code → display symbol (unknown code passes through unchanged). */
export function currencySymbol(code: string | undefined): string | undefined {
  if (!code) return undefined
  return CURRENCY_SYMBOL[code.toUpperCase()] ?? code
}

/**
 * Best-effort currency for the demo: an explicit token in the text wins; otherwise
 * infer from the tax-id kind (ИНН→RUB, УНП→BYN, БСН/БИН/ИИН/ЖСН→KZT — the demo's
 * three markets). Returns an ISO code, or undefined when nothing is recognised.
 */
export function detectCurrencyCode(text: string, taxIdKind?: TaxIdKind): string | undefined {
  // BYN before RUB: «бел. руб.» / «белорусских рублей» contain «руб», so the
  // Belarusian wording must match first — otherwise the generic RUB «руб» preempts it.
  if (/(?<![\p{L}])BYN(?![\p{L}])|(?<![\p{L}])Br(?![\p{L}])|бел[.\s]*руб|белорусск/iu.test(text)) return 'BYN'
  if (/₽|(?<![\p{L}])руб|(?<![\p{L}])rub(?![\p{L}])|российск/iu.test(text)) return 'RUB'
  if (/₸|тенге|теңге|(?<![\p{L}])KZT(?![\p{L}])/iu.test(text)) return 'KZT'
  if (/€|(?<![\p{L}])EUR(?![\p{L}])|(?<![\p{L}])евро(?![\p{L}])/iu.test(text)) return 'EUR'
  if (/\$|(?<![\p{L}])USD(?![\p{L}])|(?<![\p{L}])доллар/iu.test(text)) return 'USD'
  if (taxIdKind === 'ИНН') return 'RUB'
  if (taxIdKind === 'УНП') return 'BYN'
  if (taxIdKind === 'БИН' || taxIdKind === 'БСН' || taxIdKind === 'ИИН' || taxIdKind === 'ЖСН') return 'KZT'
  return undefined
}

// NB: JS `\b` is ASCII-only — it does NOT form a boundary next to Cyrillic/Kazakh
// letters, so we use Unicode letter lookarounds `(?<![\p{L}])…(?![\p{L}])` with the
// `u` flag wherever a whole-word match is needed.
const DOC_TYPES: Array<{ type: DemoDocType, label: string, re: RegExp }> = [
  { type: 'quote', label: 'Коммерческое предложение', re: /коммерческое\s+предложение|камерцыйн[\p{L}]*\s+прапанов[\p{L}]*|коммерциял[\p{L}]*\s+ұсын[\p{L}]*|(?<![\p{L}])КП[-\s№]/iu },
  { type: 'waybill', label: 'Товарно-транспортная накладная', re: /товарно[-\s]?транспортн[\p{L}]*|таварна[-\s]?транспартн[\p{L}]*|тауарл[\p{L}]*\s+көлік\s+жүк[\p{L}]*|(?<![\p{L}])ТТН(?![\p{L}])|жүкқұжат/iu },
  { type: 'invoice', label: 'Счёт', re: /сч[её]т[-\s]?фактур[\p{L}]*|(?<![\p{L}])сч[её]т(?![\p{L}])|рахун[\p{L}]*|шот[-\s]?фактур[\p{L}]*|(?<![\p{L}])шот(?![\p{L}])/iu }
]

const SUPPLIER_LABELS = /^(?:поставщик|пастаўшчык|жеткізуші|продавец|прадавец|сатушы)\s*[:：]?\s*(.+)$/i
const TAX_ID_RE = /(?<![\p{L}\d])(УНП|ИНН|БИН|БСН|ИИН|ЖСН)(?![\p{L}])\s*[:№]?\s*(\d{6,14})/iu
const NUMBER_RE = /(?:№|N|#)\s*([\p{L}0-9][\p{L}0-9\-/]*)/u
const DATE_RE = /(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4})/

const COL = {
  name: /наимен|найменн|номенклат|товар|тавар|тауар|атау|продук|позиц|описан|услуг|қызмет|өнім/i,
  article: /артик|артык/i,
  qty: /кол[-\s]?во|колич|колькас|сан|мөлшер/i,
  unit: /^ед\.?$|адзін|^адз\.?$|бірл/i,
  price: /цена|цана|кошт|баға|бага/i,
  sum: /сумма|сума|сомас|құн/i
}

const LANG_HINTS: Array<{ lang: DemoLang, re: RegExp }> = [
  { lang: 'kk', re: /жеткізуші|атауы|бағасы|сомасы|шот|ұсыныс|жүкқұжат|саны|БСН|ЖСН/i },
  { lang: 'be', re: /пастаўшчык|найменне|колькасць|сума|рахунак|прапанова|таварна|адзінка/i },
  { lang: 'ru', re: /поставщик|наименование|количество|сумма|счёт|счет|предложение|накладная/i }
]

/** Parse a localized number: "1 850,00" / "1850.00" / "1 850.00" → 1850. */
export function parseNum(raw: string): number | undefined {
  const s = (raw ?? '').replace(/[\s\u00A0\u202F]/g, '').trim() // strip spaces incl. NBSP
  if (!s) return undefined
  // Accounting negatives: parenthesized «(330,00)» or leading/trailing minus.
  const negative = /^\(.*\)$/.test(s) || s.startsWith('-') || s.endsWith('-')
  let body = s.replace(/^\(/, '').replace(/\)$/, '').replace(/-/g, '')
  // If both separators present, the last one is the decimal separator.
  const lastComma = body.lastIndexOf(',')
  const lastDot = body.lastIndexOf('.')
  if (lastComma >= 0 && lastDot >= 0) {
    const dec = Math.max(lastComma, lastDot)
    body = body.slice(0, dec).replace(/[.,]/g, '') + '.' + body.slice(dec + 1)
  } else if (lastComma >= 0) {
    body = body.replace(/,/g, '.')
  }
  const cleaned = body.replace(/[^0-9.]/g, '')
  if (!/\d/.test(cleaned)) return undefined
  const n = Number(cleaned)
  if (!Number.isFinite(n)) return undefined
  return negative ? -n : n
}

/**
 * Detect the table delimiter by counting how many lines split into enough cells.
 * Explicit delimiters (`|`/`\t`/`;`) need only ≥2 cells so a common 2-column price
 * list (`Наименование | Цена`) is recognised; comma needs ≥3 because it collides with
 * decimal commas («1 850,00»), so a 2-cell comma split is almost always a number, not
 * a table. We require ≥2 such "wide" lines (header + ≥1 data), but we do NOT require
 * EVERY delimited line to be wide — a real table routinely ends with a short summary
 * row (`Итого|200`), which must not veto detection. First candidate with the most wide
 * lines wins; comma is last (ambiguous with decimal commas).
 */
function detectDelimiter(lines: string[]): string | null {
  let best: { d: string, wide: number } | null = null
  for (const d of ['|', '\t', ';', ',']) {
    const minCells = d === ',' ? 3 : 2
    const wide = lines.filter(l => l.includes(d) && l.split(d).length >= minCells).length
    if (wide >= 2 && (!best || wide > best.wide)) best = { d, wide }
  }
  return best?.d ?? null
}

/** Map header cells to our column roles. */
function mapHeader(cells: string[]): Partial<Record<keyof typeof COL, number>> | null {
  const roles: Partial<Record<keyof typeof COL, number>> = {}
  cells.forEach((cell, i) => {
    const c = cell.trim()
    for (const key of Object.keys(COL) as Array<keyof typeof COL>) {
      if (roles[key] === undefined && COL[key].test(c)) roles[key] = i
    }
  })
  // A real goods table has at least a name + one numeric column.
  if (roles.name === undefined) return null
  if (roles.qty === undefined && roles.price === undefined && roles.sum === undefined) return null
  return roles
}

function detectLang(text: string): DemoLang {
  for (const h of LANG_HINTS) if (h.re.test(text)) return h.lang
  return 'unknown'
}

/** Main entry: raw document text → DemoResult. Never throws on bad input. */
export function extractDemo(input: string): DemoResult {
  const warnings: string[] = []
  const text = (input ?? '').slice(0, MAX_DEMO_CHARS)
  const lines = text.split(/\r?\n/)

  // Doc type
  let docType: DemoDocType = 'unknown'
  let docTypeLabel = 'Документ'
  for (const dt of DOC_TYPES) {
    if (dt.re.test(text)) {
      docType = dt.type
      docTypeLabel = dt.label
      break
    }
  }

  // Number / date (from the first ~15 lines — the header block)
  const head = lines.slice(0, 15).join('\n')
  const number = NUMBER_RE.exec(head)?.[1]
  const date = DATE_RE.exec(head)?.[1]

  // Supplier + tax id
  let supplier: DemoResult['supplier']
  for (const l of lines) {
    const m = SUPPLIER_LABELS.exec(l.trim())
    if (m) {
      supplier = { name: m[1]!.trim() }
      break
    }
  }
  const taxM = TAX_ID_RE.exec(text)
  if (taxM) {
    supplier = supplier ?? {}
    supplier.taxIdKind = taxM[1]!.toUpperCase() as TaxIdKind
    supplier.taxId = taxM[2]
  }

  // Goods table
  const items: DemoItem[] = []
  const totals: DemoResult['totals'] = {}
  const delim = detectDelimiter(lines)
  if (delim) {
    let roles: Partial<Record<keyof typeof COL, number>> | null = null
    for (const raw of lines) {
      if (!raw.includes(delim)) continue
      const cells = raw.split(delim).map(c => c.trim())
      if (!roles) {
        const mapped = mapHeader(cells)
        if (mapped) roles = mapped
        continue
      }
      // Totals lines (Итого / Усяго / Барлығы / НДС / ПДВ / ҚҚС / Всего)
      const joined = cells.join(' ')
      const totalKind = classifyTotal(joined)
      if (totalKind) {
        const val = lastNumber(cells)
        if (val !== undefined) totals[totalKind] = val
        continue
      }
      const name = pick(cells, roles.name)
      const quantity = parseNum(pick(cells, roles.qty))
      const price = parseNum(pick(cells, roles.price))
      const sum = parseNum(pick(cells, roles.sum))
      // A blank name cell on an otherwise numeric row = real data we must not silently
      // drop (wrapped/continuation line). Keep it with a placeholder + one warning.
      // A blank row with no numbers is just noise → skip.
      if (!name) {
        if (quantity === undefined && price === undefined && sum === undefined) continue
        if (!warnings.includes('Есть строки без наименования')) warnings.push('Есть строки без наименования')
      }
      if (items.length >= MAX_DEMO_ITEMS) {
        warnings.push('Показаны не все строки (демо-лимит)')
        break
      }
      items.push({
        name: name || '(без наименования)',
        article: pick(cells, roles.article) || undefined,
        quantity,
        unit: pick(cells, roles.unit) || undefined,
        price,
        sum
      })
    }
    if (!roles) warnings.push('Таблица товаров не распознана')
  } else {
    warnings.push('Таблица товаров не распознана')
  }

  if (!supplier?.name && !supplier?.taxId) warnings.push('Поставщик не распознан')
  if (!items.length) warnings.push('Позиции не распознаны')

  const currency = currencySymbol(detectCurrencyCode(text, supplier?.taxIdKind))

  return { docType, docTypeLabel, number, date, supplier, items, totals, currency, language: detectLang(text), warnings }
}

function pick(cells: string[], idx: number | undefined): string {
  return idx === undefined ? '' : (cells[idx] ?? '').trim()
}

function classifyTotal(s: string): 'vat' | 'total' | 'sum' | null {
  // «Всего к оплате» / «Барлығы төлеуге» is the grand total — check it before the
  // bare «Барлығы»/«Итого» (which also appears inside the grand-total phrase).
  if (/всего\s+к\s+оплате|усяго\s+да\s+аплаты|барлығы\s+төлеу|итого\s+к\s+оплате/iu.test(s)) return 'total'
  // Exclude a dash+letter suffix so a product like «НДС-насос» is NOT read as a total.
  if (/(?<![\p{L}])(ндс|пдв|ққс|қкс)(?![\p{L}-])/iu.test(s)) return 'vat'
  if (/(?<![\p{L}])(итого|усяго|разам|барлығы|жиыны)(?![\p{L}-])/iu.test(s)) return 'sum'
  return null
}

function lastNumber(cells: string[]): number | undefined {
  for (let i = cells.length - 1; i >= 0; i--) {
    const n = parseNum(cells[i]!)
    if (n !== undefined) return n
  }
  return undefined
}
